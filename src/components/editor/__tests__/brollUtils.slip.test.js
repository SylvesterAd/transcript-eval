import { describe, it, expect } from 'vitest'
import { matchPlacementsToTranscript } from '../brollUtils.js'

describe('matchPlacementsToTranscript slip fields', () => {
  const placement = {
    uuid: 'p1',
    chapterIndex: 0,
    placementIndex: 0,
    start: '[00:00:10]',
    end: '[00:00:17]',
    audio_anchor: '',
  }

  it('propagates source_in_seconds from edits to resolved placement', () => {
    const edits = { p1: { source_in_seconds: 1.5 } }
    const [resolved] = matchPlacementsToTranscript([placement], [], edits)
    expect(resolved.source_in_seconds).toBe(1.5)
  })

  it('propagates keep_original_duration and original_timeline_duration', () => {
    const edits = { p1: { keep_original_duration: true, original_timeline_duration: 7.0 } }
    const [resolved] = matchPlacementsToTranscript([placement], [], edits)
    expect(resolved.keep_original_duration).toBe(true)
    expect(resolved.original_timeline_duration).toBe(7.0)
  })

  it('propagates auto_clamp_applied', () => {
    const edits = { p1: { auto_clamp_applied: true, timelineEnd: 16.17 } }
    const [resolved] = matchPlacementsToTranscript([placement], [], edits)
    expect(resolved.auto_clamp_applied).toBe(true)
    expect(resolved.timelineEnd).toBeCloseTo(16.17, 3)
  })

  it('defaults source_in_seconds to 0 when not in edits', () => {
    const [resolved] = matchPlacementsToTranscript([placement], [], {})
    expect(resolved.source_in_seconds).toBe(0)
  })

  it('honors edits.timelineEnd alone when auto_clamp_applied (no timelineStart in edits)', () => {
    const edits = { p1: { auto_clamp_applied: true, timelineEnd: 16.17 } }
    const [resolved] = matchPlacementsToTranscript([placement], [], edits)
    // placement.start = '[00:00:10]' → 10s, edit.timelineEnd = 16.17 → resolved timelineDuration = 6.17
    expect(resolved.timelineStart).toBe(10)
    expect(resolved.timelineEnd).toBeCloseTo(16.17, 3)
    expect(resolved.timelineDuration).toBeCloseTo(6.17, 3)
  })
})
