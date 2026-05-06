// Tests for filterStagesForMedia in broll.js — runtime defense-in-depth filter
// that drops video-only stage types (video_llm, video_question) targeting
// main_video when the main media is audio. For video media it is a pass-through.
//
// This is a safety net for the case where a user manually picks the wrong
// strategy for an audio group, or future strategies have video stages we
// forget to drop. The audio-only seed strategy (Task 5) already excludes
// these stages — this filter catches the cases that slip through.

import { describe, it, expect, vi } from 'vitest'

// broll.js → llm-runner.js / db imports require a live DATABASE_URL at module
// load. Mock the db module so module load succeeds in unit tests. Mirrors the
// pattern used by broll-extract-json.test.js.
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ changes: 0 }),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

import { __test__filterStagesForMedia as filterStagesForMedia } from '../broll.js'

describe('filterStagesForMedia (audio)', () => {
  it('drops video_llm/video_question stages targeting main_video when audio', () => {
    const stages = [
      { name: '1. Segment', type: 'programmatic', target: 'text_only' },
      { name: '2. Analyze A-Roll', type: 'video_llm', target: 'main_video' },
      { name: '3. Plan', type: 'transcript_llm', target: 'main_video' },
      { name: '4. Reference scan', type: 'video_question', target: 'examples' },
    ]
    const out = filterStagesForMedia(stages, 'audio')
    expect(out.map(s => s.name)).toEqual(['1. Segment', '3. Plan', '4. Reference scan'])
  })

  it('passes everything through for video', () => {
    const stages = [
      { name: 'A', type: 'video_llm', target: 'main_video' },
      { name: 'B', type: 'transcript_llm', target: 'main_video' },
    ]
    const out = filterStagesForMedia(stages, 'video')
    expect(out.map(s => s.name)).toEqual(['A', 'B'])
  })

  it('drops programmatic stages with video-only actions when audio', () => {
    const stages = [
      { name: 'Export post-cut video', type: 'programmatic', target: 'text_only', action: 'export_post_cut_video' },
      { name: 'Segment transcript', type: 'programmatic', target: 'text_only', action: 'segment' },
    ]
    const out = filterStagesForMedia(stages, 'audio')
    expect(out.map(s => s.name)).toEqual(['Segment transcript'])
  })

  it('keeps all programmatic stages for video', () => {
    const stages = [
      { name: 'Export post-cut video', type: 'programmatic', target: 'text_only', action: 'export_post_cut_video' },
      { name: 'Segment transcript', type: 'programmatic', target: 'text_only', action: 'segment' },
    ]
    const out = filterStagesForMedia(stages, 'video')
    expect(out.map(s => s.name)).toEqual(['Export post-cut video', 'Segment transcript'])
  })

  it('remaps *StageIndex params on kept stages when audio drops earlier stages', () => {
    // Mirrors strategy 7's structure: drop indices 1 (Export post-cut video)
    // and 2 (Analyze A-Roll). The split_by_chapter stage's params reference
    // those original indices and must be remapped or nulled.
    const stages = [
      { name: '0 transcript', type: 'programmatic', target: 'text_only', action: 'generate_post_cut_transcript', params: {} },
      { name: '1 export-video', type: 'programmatic', target: 'text_only', action: 'export_post_cut_video', params: {} },
      { name: '2 a-roll', type: 'video_question', target: 'main_video', params: {} },
      { name: '3 chapters', type: 'transcript_question', target: 'main_video', params: {} },
      { name: '4 split', type: 'programmatic', target: 'text_only', action: 'split_by_chapter', params: { chaptersStageIndex: 3, aRollStageIndex: 2 } },
    ]
    const out = filterStagesForMedia(stages, 'audio')
    expect(out.map(s => s.name)).toEqual(['0 transcript', '3 chapters', '4 split'])
    // chapters was at original index 3, now sits at new index 1
    expect(out[2].params.chaptersStageIndex).toBe(1)
    // a-roll (original index 2) was dropped → param nulled
    expect(out[2].params.aRollStageIndex).toBe(null)
  })

  it('does not mutate the input stage objects when remapping', () => {
    const stages = [
      { name: '0', type: 'video_question', target: 'main_video' },
      { name: '1', type: 'programmatic', target: 'text_only', action: 'split_by_chapter', params: { chaptersStageIndex: 0 } },
    ]
    const before = JSON.stringify(stages)
    filterStagesForMedia(stages, 'audio')
    expect(JSON.stringify(stages)).toBe(before)
  })
})
