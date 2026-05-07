import { describe, it, expect } from 'vitest'
import { findAnchorWordIdx } from '../anchor-word.js'

const words = [
  { word: 'There', start: 19.94, end: 20.10 },
  { word: 'is', start: 20.10, end: 20.18 },
  { word: 'a', start: 20.18, end: 20.21 },
  { word: 'bad', start: 20.21, end: 20.50 },
  { word: 'piece', start: 20.50, end: 20.78 },
  { word: 'of', start: 20.78, end: 20.85 },
  { word: 'advice', start: 20.85, end: 21.30 },
  { word: 'There', start: 100.00, end: 100.16 },  // duplicate phrase later
  { word: 'is', start: 100.16, end: 100.24 },
  { word: 'a', start: 100.24, end: 100.27 },
  { word: 'good', start: 100.27, end: 100.50 },
  { word: 'piece', start: 100.50, end: 100.78 },
]

describe('findAnchorWordIdx', () => {
  it('returns word index for an exact phrase match', () => {
    expect(findAnchorWordIdx(words, 'There is a bad piece')).toBe(0)
  })

  it('matches whole-word, case-insensitive, ignoring punctuation', () => {
    expect(findAnchorWordIdx(words, "There's a bad piece of advice.")).toBe(0)
  })

  it('returns -1 when phrase not found', () => {
    expect(findAnchorWordIdx(words, 'never appears here')).toBe(-1)
  })

  it('returns earliest match when phrase is ambiguous (nearest to t=0 tiebreaker)', () => {
    expect(findAnchorWordIdx(words, 'There is a')).toBe(0)
  })

  it('handles single-word anchor', () => {
    expect(findAnchorWordIdx(words, 'advice')).toBe(6)
  })

  it('returns -1 on empty/null input', () => {
    expect(findAnchorWordIdx([], 'x')).toBe(-1)
    expect(findAnchorWordIdx(words, '')).toBe(-1)
    expect(findAnchorWordIdx(null, 'x')).toBe(-1)
    expect(findAnchorWordIdx(words, null)).toBe(-1)
  })
})
