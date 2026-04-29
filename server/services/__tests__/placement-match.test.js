// Tests for the server-side mirror of brollUtils.matchPlacementsToTranscript.
// The export pipeline relies on this snapping to match the editor's
// displayed start times. Algorithm changes must be made in lockstep
// with the client copy.

import { describe, it, expect } from 'vitest'
import { parseTimecode, matchPlacementsToTranscript } from '../placement-match.js'

describe('parseTimecode', () => {
  it('parses bracketed hh:mm:ss', () => {
    expect(parseTimecode('[00:01:13]')).toBe(73)
    expect(parseTimecode('[01:02:03]')).toBe(3723)
  })
  it('parses bare hh:mm:ss', () => {
    expect(parseTimecode('00:01:13')).toBe(73)
  })
  it('parses mm:ss', () => {
    expect(parseTimecode('01:13')).toBe(73)
  })
  it('returns 0 for empty / null', () => {
    expect(parseTimecode('')).toBe(0)
    expect(parseTimecode(null)).toBe(0)
    expect(parseTimecode(undefined)).toBe(0)
  })
})

describe('matchPlacementsToTranscript', () => {
  it('snaps placement to the transcript word matching its audio_anchor', () => {
    // Plan says start "[00:01:13]" (=73s). The first transcript word
    // whose surrounding phrase scores highest against the anchor is
    // "hit" at 73.0s. The editor + export both pick that word's start.
    const placements = [{
      chapterIndex: 0, placementIndex: 13,
      start: '[00:01:13]', end: '[00:01:15]',
      audio_anchor: 'hit TV show Hercules',
      results: [],
    }]
    const words = [
      // Distractors OUTSIDE the ±30s anchor-search window (plan start
      // = 73s → window [43, 105]). 30s falls outside, so these never
      // become candidates.
      { word: 'completely', start: 30.0, end: 30.3 },
      { word: 'different', start: 30.4, end: 30.7 },
      // Real anchor match starts at 73.0 ('hit'); algorithm picks the
      // first word of the anchor phrase as timelineStart.
      { word: 'hit', start: 73.0, end: 73.2 },
      { word: 'TV', start: 73.2, end: 73.4 },
      { word: 'show', start: 73.4, end: 73.6 },
      { word: 'Hercules', start: 73.64, end: 74.2 },
    ]
    const out = matchPlacementsToTranscript(placements, words)
    expect(out).toHaveLength(1)
    expect(out[0].timelineStart).toBe(73.0)
    // Duration preserved from plan: 75 - 73 = 2s
    expect(out[0].timelineDuration).toBe(2)
  })

  it('falls back to plan timecode when no anchor matches the transcript', () => {
    const placements = [{
      chapterIndex: 0, placementIndex: 0,
      start: '[00:01:13]', end: '[00:01:15]',
      audio_anchor: 'nothing in the transcript',
      results: [],
    }]
    const words = [
      { word: 'completely', start: 70.0, end: 70.2 },
      { word: 'unrelated', start: 70.2, end: 70.4 },
    ]
    const out = matchPlacementsToTranscript(placements, words)
    expect(out[0].timelineStart).toBe(73)
    expect(out[0].timelineEnd).toBe(75)
  })

  it('user-edited timing wins over both anchor-match and plan timecode', () => {
    const placements = [{
      chapterIndex: 0, placementIndex: 0,
      start: '[00:01:13]', end: '[00:01:15]',
      audio_anchor: 'Hercules',
      userTimelineStart: 99.5,
      userTimelineEnd: 102.0,
      results: [],
    }]
    const words = [{ word: 'Hercules', start: 73.64, end: 74.2 }]
    const out = matchPlacementsToTranscript(placements, words)
    expect(out[0].timelineStart).toBe(99.5)
    expect(out[0].timelineEnd).toBe(102.0)
    expect(out[0].timelineDuration).toBe(2.5)
  })

  it('skips hidden placements when editsByKey provided', () => {
    const placements = [
      { chapterIndex: 0, placementIndex: 0, start: '[00:00:00]', end: '[00:00:02]', audio_anchor: '', results: [] },
      { chapterIndex: 0, placementIndex: 1, start: '[00:00:05]', end: '[00:00:07]', audio_anchor: '', results: [] },
    ]
    const editsByKey = { '0:1': { hidden: true } }
    const out = matchPlacementsToTranscript(placements, [], editsByKey)
    expect(out).toHaveLength(1)
    expect(out[0].placementIndex).toBe(0)
  })

  it('trims earlier-end when two placements would overlap on the timeline', () => {
    const placements = [
      { chapterIndex: 0, placementIndex: 0, start: '[00:00:00]', end: '[00:00:10]', audio_anchor: '', results: [] },
      { chapterIndex: 0, placementIndex: 1, start: '[00:00:05]', end: '[00:00:15]', audio_anchor: '', results: [] },
    ]
    const out = matchPlacementsToTranscript(placements, [])
    expect(out[0].timelineStart).toBe(0)
    expect(out[0].timelineEnd).toBe(5)            // trimmed at next.start
    expect(out[0].timelineDuration).toBe(5)
    expect(out[1].timelineStart).toBe(5)
    expect(out[1].timelineEnd).toBe(15)
  })

  it('returns the input untouched when placements is empty', () => {
    expect(matchPlacementsToTranscript([], [])).toEqual([])
    expect(matchPlacementsToTranscript(null, [])).toEqual([])
    expect(matchPlacementsToTranscript(undefined, [])).toEqual([])
  })
})
