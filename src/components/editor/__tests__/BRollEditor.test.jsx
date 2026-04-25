import { describe, it, expect, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Pure function under test — extract URL→selection resolver.
import { resolveDetailToIndex } from '../BRollEditor.jsx'

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
