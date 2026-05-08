import { describe, it, expect } from 'vitest'
import { deriveSilences } from '../silences.js'

describe('deriveSilences', () => {
  it('returns gap between two words longer than min_duration', () => {
    const words = [
      { word: 'hello', start: 0, end: 1 },
      { word: 'world', start: 3, end: 4 },
    ]
    expect(deriveSilences(words, 0.75)).toEqual([
      { start: 1, end: 3, duration: 2 },
    ])
  })

  it('skips gaps shorter than min_duration', () => {
    const words = [
      { word: 'hi', start: 0, end: 1 },
      { word: 'there', start: 1.2, end: 2 },
    ]
    expect(deriveSilences(words, 0.75)).toEqual([])
  })

  it('respects scope filter', () => {
    const words = [
      { word: 'a', start: 0, end: 1 },
      { word: 'b', start: 5, end: 6 },
      { word: 'c', start: 10, end: 11 },
      { word: 'd', start: 20, end: 21 },
    ]
    const out = deriveSilences(words, 0.75, { start: 5, end: 15 })
    expect(out).toEqual([
      { start: 6, end: 10, duration: 4 },
    ])
  })

  it('returns [] for empty input', () => {
    expect(deriveSilences([], 0.75)).toEqual([])
  })
})
