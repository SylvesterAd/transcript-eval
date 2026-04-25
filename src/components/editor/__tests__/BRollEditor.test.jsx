import { describe, it, expect, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Pure function under test — extract URL→selection resolver.
import { resolveDetailToIndex } from '../BRollEditor.jsx'
import { resolveDisplayResultIdx } from '../BRollTrack.jsx'

describe('resolveDetailToIndex', () => {
  it('returns numeric index for plain numeric detail', () => {
    expect(resolveDetailToIndex('5')).toBe(5)
  })

  it('returns string identity for userPlacement detail', () => {
    expect(resolveDetailToIndex('user:u_a13ddc21-aa3')).toBe('user:u_a13ddc21-aa3')
  })

  it('returns null for empty detail', () => {
    expect(resolveDetailToIndex(undefined)).toBe(null)
    expect(resolveDetailToIndex(null)).toBe(null)
    expect(resolveDetailToIndex('')).toBe(null)
  })

  it('returns null for unparseable detail', () => {
    expect(resolveDetailToIndex('garbage')).toBe(null)
  })
})

describe('resolveDisplayResultIdx', () => {
  it('uses transient selectedResults when present (active row)', () => {
    expect(resolveDisplayResultIdx({ index: 5, persistedSelectedResult: 3 }, true, { 5: 7 })).toBe(7)
  })
  it('falls back to persistedSelectedResult when no transient (active row)', () => {
    expect(resolveDisplayResultIdx({ index: 5, persistedSelectedResult: 3 }, true, {})).toBe(3)
  })
  it('falls back to 0 when neither present (active row)', () => {
    expect(resolveDisplayResultIdx({ index: 5 }, true, {})).toBe(0)
  })
  it('uses persistedSelectedResult on inactive row regardless of selectedResults', () => {
    expect(resolveDisplayResultIdx({ index: 5, persistedSelectedResult: 3 }, false, { 5: 7 })).toBe(3)
  })
})
