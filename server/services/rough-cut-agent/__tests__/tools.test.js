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
  it('exports all 12 tool schemas with Anthropic-compatible shape', () => {
    const expected = ['get_transcript', 'get_chapters', 'get_silences', 'get_audio_events',
      'search_transcript', 'find_interruption_clusters', 'propose_cut', 'mark_uncertain',
      'remove_cut', 'adjust_cut', 'preview_diff', 'finish']
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
