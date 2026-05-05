// Tests for buildSpecialAudioNote in broll.js — verbatim text injected into
// LLM stage prompts/system instructions when the main video media is audio.
// For video media the helper returns '' so the {{special_audio_note}}
// placeholder expands to nothing and existing prompts are unchanged.

import { describe, it, expect, vi } from 'vitest'

// broll.js imports db / llm-runner at module load. Mock the db module so the
// module loads in unit tests (mirrors broll-audio-stage-filter.test.js).
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ changes: 0 }),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

import { __test__buildSpecialAudioNote as buildSpecialAudioNote } from '../broll.js'

describe('buildSpecialAudioNote', () => {
  it('returns empty string for video media', () => {
    expect(buildSpecialAudioNote('video')).toBe('')
  })
  it('returns the voice-over instruction for audio media', () => {
    const note = buildSpecialAudioNote('audio')
    expect(note).toContain('only Voice over')
    expect(note).toContain('b-rolls all the time')
    expect(note).toContain('without ANY empty spaces')
  })
  it('falls back to empty for unknown values', () => {
    expect(buildSpecialAudioNote(null)).toBe('')
    expect(buildSpecialAudioNote(undefined)).toBe('')
    expect(buildSpecialAudioNote('script')).toBe('')
  })
})
