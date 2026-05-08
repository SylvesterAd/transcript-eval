import { describe, it, expect, vi } from 'vitest'
import { TOOL_SCHEMAS, dispatchTool } from '../tools.js'
import { createState } from '../state.js'

const sampleWords = [
  { word: 'Hello', start: 0, end: 1 },
  { word: 'world.', start: 1, end: 2 },
  { word: 'Um,', start: 3, end: 3.4 },
  { word: '[keyboard clacking]', type: 'audio_event', start: 4, end: 6 },
  { word: 'Nice.', start: 6.1, end: 6.5 },
]

const sampleTranscript = `[00:00:00] Hello world.
[00:00:03] Um,
[00:00:06] Nice.`

function makeState() {
  return createState({ assembledTranscript: sampleTranscript, wordTimestamps: sampleWords })
}

describe('TOOL_SCHEMAS', () => {
  it('exports all 14 tool schemas with Anthropic-compatible shape', () => {
    const expected = ['get_transcript', 'get_chapters', 'get_silences', 'get_audio_events',
      'search_transcript', 'find_interruption_clusters', 'propose_cut', 'mark_uncertain',
      'remove_cut', 'adjust_cut', 'preview_diff', 'commit_chunk', 'get_acoustic_features', 'finish']
    const names = TOOL_SCHEMAS.map(t => t.name)
    for (const e of expected) expect(names).toContain(e)
    for (const t of TOOL_SCHEMAS) {
      expect(t.input_schema).toBeDefined()
      expect(t.input_schema.type).toBe('object')
    }
  })
})

describe('dispatchTool', () => {
  it('get_transcript returns words array', async () => {
    const r = await dispatchTool('get_transcript', {}, makeState())
    expect(Array.isArray(r.words)).toBe(true)
    expect(r.words.length).toBe(sampleWords.length)
  })

  it('get_transcript with scope filters', async () => {
    const r = await dispatchTool('get_transcript', { scope: { start: 0, end: 2.5 } }, makeState())
    expect(r.words.length).toBe(2)
  })

  it('get_transcript adds pause_before to each word', async () => {
    const r = await dispatchTool('get_transcript', {}, makeState())
    // sampleWords: Hello (0-1), world (1-2), Um (3-3.4), [keyboard] (4-6), Nice (6.1-6.5)
    expect(r.words[0].pause_before).toBe(0)         // first word
    expect(r.words[1].pause_before).toBe(0)         // 1.0 - 1.0 = 0 (back-to-back)
    expect(r.words[2].pause_before).toBeCloseTo(1)  // 3.0 - 2.0 = 1.0s
    expect(r.words[3].pause_before).toBeCloseTo(0.6) // 4.0 - 3.4 = 0.6
    expect(r.words[4].pause_before).toBeCloseTo(0.1) // 6.1 - 6.0 = 0.1
  })

  it('get_transcript pause_before never negative when word starts mid-prev', async () => {
    const overlapping = [
      { word: 'a', start: 0, end: 1 },
      { word: 'b', start: 0.5, end: 1.5 },
    ]
    const state = createState({ assembledTranscript: '', wordTimestamps: overlapping })
    const r = await dispatchTool('get_transcript', {}, state)
    expect(r.words[1].pause_before).toBe(0)
  })

  it('get_silences wraps deriveSilences', async () => {
    const r = await dispatchTool('get_silences', { min_duration: 0.75 }, makeState())
    expect(r.silences.length).toBeGreaterThan(0)
  })

  it('get_audio_events filters audio_event tokens', async () => {
    const r = await dispatchTool('get_audio_events', {}, makeState())
    expect(r.events.length).toBe(1)
    expect(r.events[0].type).toBe('audio_event')
  })

  it('get_audio_events filters by types', async () => {
    const r = await dispatchTool('get_audio_events', { types: ['laughter'] }, makeState())
    expect(r.events.length).toBe(0)
  })

  it('search_transcript matches regex', async () => {
    const r = await dispatchTool('search_transcript', { pattern: '\\bUm\\b' }, makeState())
    expect(r.matches.length).toBe(1)
    expect(r.matches[0].text).toContain('Um')
  })

  it('find_interruption_clusters returns clusters', async () => {
    const r = await dispatchTool('find_interruption_clusters', { max_gap_sec: 5 }, makeState())
    expect(r.clusters.length).toBe(1)
    expect(r.clusters[0].suggested_category).toBe('meta_commentary')
  })

  it('propose_cut appends to state.cuts and returns id', async () => {
    const state = makeState()
    const r = await dispatchTool('propose_cut', {
      start: 3, end: 3.4,
      category: 'filler_word',
      reason: '"Um" with adjacent silence',
      confidence: 0.9,
      evidence: ['text: "Um,"']
    }, state)
    expect(r.cut_id).toMatch(/^cut_/)
    expect(state.cuts.length).toBe(1)
  })

  it('remove_cut removes by id', async () => {
    const state = makeState()
    const { cut_id } = await dispatchTool('propose_cut', {
      start: 0, end: 1, category: 'filler_word', reason: '', confidence: 0.5, evidence: []
    }, state)
    const r = await dispatchTool('remove_cut', { cut_id }, state)
    expect(r.removed).toBe(true)
    expect(state.cuts.length).toBe(0)
  })

  it('adjust_cut updates timing', async () => {
    const state = makeState()
    const { cut_id } = await dispatchTool('propose_cut', {
      start: 0, end: 1, category: 'filler_word', reason: '', confidence: 0.5, evidence: []
    }, state)
    const r = await dispatchTool('adjust_cut', { cut_id, new_start: 0.5, new_end: 1.5 }, state)
    expect(r.adjusted).toBe(true)
    expect(state.cuts[0].start).toBe(0.5)
  })

  it('mark_uncertain appends to uncertain array', async () => {
    const state = makeState()
    const r = await dispatchTool('mark_uncertain', { start: 4, end: 6, reason: 'ambiguous' }, state)
    expect(r.uncertain_id).toMatch(/^uncertain_/)
    expect(state.uncertain.length).toBe(1)
  })

  it('preview_diff returns transcript with cuts removed', async () => {
    const state = makeState()
    await dispatchTool('propose_cut', {
      start: 3, end: 3.4, category: 'filler_word', reason: '', confidence: 0.9, evidence: []
    }, state)
    const r = await dispatchTool('preview_diff', {}, state)
    expect(r.preview).not.toContain('Um,')
    expect(r.preview).toContain('Hello world.')
  })

  it('preview_diff with scope only returns lines within window', async () => {
    const state = makeState()
    const r = await dispatchTool('preview_diff', { scope: { start: 2.5, end: 7 } }, state)
    expect(r.preview).not.toContain('Hello world.')
    expect(r.preview).toContain('Um,')
    expect(r.preview).toContain('Nice.')
  })

  it('preview_diff with scope still respects cuts inside window', async () => {
    const state = makeState()
    await dispatchTool('propose_cut', {
      start: 3, end: 3.4, category: 'filler_word', reason: '', confidence: 0.9, evidence: []
    }, state)
    const r = await dispatchTool('preview_diff', { scope: { start: 2.5, end: 7 } }, state)
    expect(r.preview).not.toContain('Um,')
    expect(r.preview).toContain('Nice.')
    expect(r.preview).not.toContain('Hello world.')
  })

  it('commit_chunk returns match_percent and actual_text', async () => {
    const state = makeState()
    await dispatchTool('propose_cut', {
      start: 3, end: 3.4, category: 'filler_word', reason: '', confidence: 0.9, evidence: []
    }, state)
    const r = await dispatchTool('commit_chunk', {
      scope: { start: 0, end: 7 },
      expected_text_after_cuts: 'Hello world. Nice.',
    }, state)
    expect(typeof r.match_percent).toBe('number')
    expect(r.match_percent).toBeGreaterThan(0.6)
    expect(r.actual_text).toContain('Hello world.')
    expect(r.actual_text).toContain('Nice.')
    expect(r.actual_text).not.toContain('Um,')
  })

  it('commit_chunk flags low match when prediction diverges from cuts', async () => {
    const state = makeState()
    // Predict "Hello world." surviving, but cut nothing — actual will include Um and Nice.
    const r = await dispatchTool('commit_chunk', {
      scope: { start: 0, end: 7 },
      expected_text_after_cuts: 'Hello world.',
    }, state)
    expect(r.match_percent).toBeLessThan(0.7)
    expect(Array.isArray(r.mismatches)).toBe(true)
    expect(r.mismatches.length).toBeGreaterThan(0)
  })

  it('commit_chunk requires scope and expected_text_after_cuts', async () => {
    const state = makeState()
    await expect(dispatchTool('commit_chunk', {}, state)).rejects.toThrow(/scope/i)
    await expect(dispatchTool('commit_chunk', { scope: { start: 0, end: 1 } }, state))
      .rejects.toThrow(/expected_text/i)
  })

  it('finish returns summary stats', async () => {
    const state = makeState()
    await dispatchTool('propose_cut', {
      start: 3, end: 3.4, category: 'filler_word', reason: '', confidence: 0.9, evidence: []
    }, state)
    const r = await dispatchTool('finish', { summary: 'done' }, state)
    expect(r.cuts_emitted).toBe(1)
    expect(r.marked_uncertain).toBe(0)
    expect(r.summary).toBe('done')
  })

  it('get_chapters caches via injected fetcher', async () => {
    const state = makeState()
    const fetcher = vi.fn().mockResolvedValue([{ start: 0, end: 10, name: 'ch1' }])
    const r1 = await dispatchTool('get_chapters', {}, state, { chaptersFetcher: fetcher })
    const r2 = await dispatchTool('get_chapters', {}, state, { chaptersFetcher: fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(r1.chapters[0].name).toBe('ch1')
    expect(r2.chapters[0].name).toBe('ch1')
  })

  it('throws on unknown tool name', async () => {
    await expect(dispatchTool('does_not_exist', {}, makeState())).rejects.toThrow(/unknown/i)
  })

  describe('get_acoustic_features', () => {
    function makeStateWithAcoustic() {
      // 5 seconds of frames at 100ms hop. Word "Hello" 0–1s, "world" 1–2s,
      // gap 2–4s, "Now" 4–5s. Voiced through speech, unvoiced in gap.
      const frames = []
      for (let i = 0; i < 50; i++) {
        const t = i * 0.1
        const inGap = t >= 2 && t < 4
        frames.push([
          +t.toFixed(1),
          inGap ? -55 : -28,    // rms_db
          inGap ? 0 : 140,      // f0
          inGap ? 0 : 1,        // f0_voiced
          inGap ? 3000 : 1800,  // spectral_centroid
          inGap ? 0.05 : 0.15,  // zcr
        ])
      }
      const acoustic = {
        hop_ms: 100,
        duration_s: 5,
        features: ['rms_db', 'f0', 'f0_voiced', 'spectral_centroid', 'zcr'],
        frames,
      }
      const words = [
        { word: 'Hello', start: 0, end: 1 },
        { word: 'world.', start: 1, end: 2 },
        { word: 'Now', start: 4, end: 5 },
      ]
      const state = createState({ assembledTranscript: '', wordTimestamps: words })
      state.setAcousticFeatures(acoustic)
      return state
    }

    it('reports unavailable when transcripts.acoustic_features_json is null', async () => {
      const state = makeState()  // no acoustic features set
      const r = await dispatchTool('get_acoustic_features', {}, state)
      expect(r.available).toBe(false)
    })

    it('default granularity is per-word, returns aggregate stats', async () => {
      const state = makeStateWithAcoustic()
      const r = await dispatchTool('get_acoustic_features', {}, state)
      expect(r.available).toBe(true)
      expect(r.granularity).toBe('word')
      expect(r.words).toHaveLength(3)
      const hello = r.words[0]
      expect(hello.word).toBe('Hello')
      expect(hello.rms_mean).toBeCloseTo(-28, 0)
      expect(hello.voiced_ratio).toBeCloseTo(1, 1)
      expect(hello.f0_mean).toBeCloseTo(140, 0)
    })

    it('per-word includes pause_before_voiced_ratio across the gap', async () => {
      const state = makeStateWithAcoustic()
      const r = await dispatchTool('get_acoustic_features', {}, state)
      const now = r.words.find(w => w.word === 'Now')
      // "Now" is preceded by a 2s gap (2–4s) where voiced=0, so the prior
      // pause is mostly silence: pause_before_voiced_ratio should be near 0.
      expect(now.pause_before_voiced_ratio).toBeLessThan(0.2)
      // And rms_drop_before should be > 20 dB (-28 to -55)
      expect(now.rms_drop_before).toBeGreaterThan(15)
    })

    it('frame granularity returns raw frames in scope', async () => {
      const state = makeStateWithAcoustic()
      const r = await dispatchTool('get_acoustic_features', {
        granularity: 'frame',
        scope: { start: 1, end: 3 },
      }, state)
      expect(r.granularity).toBe('frame')
      expect(r.frames.length).toBeGreaterThan(15)  // ~20 frames at 100ms
      expect(r.frames.length).toBeLessThan(25)
      // First frame should be at t≈1.0
      expect(r.frames[0][0]).toBeCloseTo(1, 1)
    })

    it('scope filter applies to per-word too', async () => {
      const state = makeStateWithAcoustic()
      const r = await dispatchTool('get_acoustic_features', {
        scope: { start: 0, end: 2.5 },
      }, state)
      expect(r.words).toHaveLength(2)
      expect(r.words.map(w => w.word)).toEqual(['Hello', 'world.'])
    })
  })

  it('get_audio_events detects bracketed-word audio events without type field', async () => {
    const words = [
      { word: 'hi', start: 0, end: 1 },
      { word: '[keyboard clacking]', start: 5, end: 7 },
      { word: '[door slam]', start: 10, end: 11 },
    ]
    const state = createState({ assembledTranscript: '', wordTimestamps: words })
    const r = await dispatchTool('get_audio_events', {}, state)
    expect(r.events.length).toBe(2)
    expect(r.events[0].tc).toBe('[keyboard clacking]')
  })
})
