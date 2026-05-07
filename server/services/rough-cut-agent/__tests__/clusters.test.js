import { describe, it, expect } from 'vitest'
import { findInterruptionClusters } from '../clusters.js'

// Fixture: simulate the run-166 keyboard-clacking moment.
// Words: "Ooh, gotta pause for a second and look something up."
//        [keyboard clacking] (audio event)
//        "Nice." (short utterance after)
//        "Okay." (short utterance after)
const RUN_166_FIXTURE = [
  { word: 'Ooh,',    start: 428.72, end: 429.10 },
  { word: 'gotta',   start: 429.10, end: 429.30 },
  { word: 'pause',   start: 429.30, end: 429.60 },
  { word: 'for',     start: 429.60, end: 429.80 },
  { word: 'a',       start: 429.80, end: 429.90 },
  { word: 'second',  start: 429.90, end: 430.30 },
  { word: 'and',     start: 430.30, end: 430.50 },
  { word: 'look',    start: 430.50, end: 430.80 },
  { word: 'something', start: 430.80, end: 431.20 },
  { word: 'up.',     start: 431.20, end: 431.60 },
  { word: '[keyboard clacking]', type: 'audio_event', start: 432.14, end: 438.50 },
  { word: 'Nice.',   start: 438.50, end: 438.90 },
  { word: 'Okay.',   start: 439.60, end: 440.00 },
  // Then real content resumes after a long gap
  { word: 'So',      start: 446.00, end: 446.20 },
  { word: 'the',     start: 446.20, end: 446.40 },
  { word: 'first',   start: 446.40, end: 446.80 },
]

describe('findInterruptionClusters', () => {
  it('returns the keyboard-clacking cluster from run-166 as a single span', () => {
    const clusters = findInterruptionClusters(RUN_166_FIXTURE, { maxGapSec: 5 })
    expect(clusters.length).toBe(1)
    const c = clusters[0]
    expect(c.start).toBeGreaterThan(428)
    expect(c.start).toBeLessThan(429)
    expect(c.end).toBeGreaterThan(439)
    expect(c.end).toBeLessThan(441)
    expect(c.suggested_category).toBe('meta_commentary')
    expect(c.elements.some(e => e.type === 'audio_event')).toBe(true)
  })

  it('returns [] when no audio events are present', () => {
    const words = [
      { word: 'a', start: 0, end: 1 },
      { word: 'b', start: 1, end: 2 },
    ]
    expect(findInterruptionClusters(words)).toEqual([])
  })

  it('does not merge clusters separated by more than max_gap_sec', () => {
    const words = [
      { word: '[keyboard clacking]', type: 'audio_event', start: 0, end: 1 },
      { word: 'ok', start: 1, end: 2 },
      { word: 'real content here that goes on for a while', start: 30, end: 35 },
      { word: '[door slam]', type: 'audio_event', start: 60, end: 61 },
    ]
    const clusters = findInterruptionClusters(words, { maxGapSec: 5 })
    expect(clusters.length).toBe(2)
  })

  it('respects scope filter', () => {
    const words = [
      { word: '[keyboard clacking]', type: 'audio_event', start: 5, end: 6 },
      { word: '[door slam]', type: 'audio_event', start: 100, end: 101 },
    ]
    const clusters = findInterruptionClusters(words, { scope: { start: 0, end: 50 } })
    expect(clusters.length).toBe(1)
    expect(clusters[0].start).toBeLessThan(50)
  })

  it('detects bracketed-word audio events without a type field (production format)', () => {
    const words = [
      { word: 'speaker', start: 0, end: 0.5 },
      { word: 'pauses.', start: 0.5, end: 1 },
      { word: '[keyboard clacking]', start: 2, end: 8 },
      { word: 'Okay,', start: 8.2, end: 8.5 },
      { word: 'continuing', start: 12, end: 13 },
    ]
    const clusters = findInterruptionClusters(words, { maxGapSec: 5 })
    expect(clusters.length).toBe(1)
    expect(clusters[0].suggested_category).toBe('meta_commentary')
    expect(clusters[0].elements.some(e => /^\[/.test(e.word))).toBe(true)
  })
})
