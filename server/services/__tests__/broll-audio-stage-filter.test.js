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
})
