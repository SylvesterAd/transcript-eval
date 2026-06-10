import { describe, it, expect, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Pure functions under test — URL→selection resolver and selection→URL slug builder.
import { resolveDetailToIndex, detailForSelection } from '../BRollEditor.jsx'
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

describe('resolveDetailToIndex with placements (uuid slugs)', () => {
  const placements = [
    { index: 0, uuid: 'p_0d6404d81a07' },
    { index: 1, uuid: 'p_aaaabbbbcccc' },
    { index: 2, uuid: null }, // legacy plan placement without backfilled uuid
    { index: 'user:u_12345678-90a', uuid: 'u_12345678-90a', userPlacementId: 'u_12345678-90a' },
  ]

  it('resolves a plan placement uuid to its numeric index', () => {
    expect(resolveDetailToIndex('p_0d6404d81a07', placements)).toBe(0)
    expect(resolveDetailToIndex('p_aaaabbbbcccc', placements)).toBe(1)
  })

  it('resolves a user placement uuid to its user: index', () => {
    expect(resolveDetailToIndex('u_12345678-90a', placements)).toBe('user:u_12345678-90a')
  })

  it('returns null for a uuid not present in placements', () => {
    expect(resolveDetailToIndex('p_deadbeef0000', placements)).toBe(null)
  })

  it('still resolves legacy numeric details when placements are provided', () => {
    expect(resolveDetailToIndex('2', placements)).toBe(2)
  })

  it('keeps legacy user: passthrough when placements are provided', () => {
    expect(resolveDetailToIndex('user:u_12345678-90a', placements)).toBe('user:u_12345678-90a')
  })

  it('returns null for a uuid-shaped detail when placements are absent', () => {
    expect(resolveDetailToIndex('p_0d6404d81a07')).toBe(null)
    expect(resolveDetailToIndex('p_0d6404d81a07', [])).toBe(null)
  })
})

describe('detailForSelection', () => {
  const placements = [
    { index: 0, uuid: 'p_0d6404d81a07' },
    { index: 1, uuid: null }, // legacy plan placement without backfilled uuid
    { index: 'user:u_12345678-90a', uuid: 'u_12345678-90a', userPlacementId: 'u_12345678-90a' },
  ]

  it('returns the placement uuid for a selected plan placement', () => {
    expect(detailForSelection(0, placements)).toBe('p_0d6404d81a07')
  })

  it('returns the uuid for a selected user placement', () => {
    expect(detailForSelection('user:u_12345678-90a', placements)).toBe('u_12345678-90a')
  })

  it('falls back to the index when the placement has no uuid', () => {
    expect(detailForSelection(1, placements)).toBe('1')
  })

  it('falls back to the index when the placement is not found yet', () => {
    expect(detailForSelection(3, placements)).toBe('3')
    expect(detailForSelection(0, null)).toBe('0')
  })

  it('returns undefined when nothing is selected', () => {
    expect(detailForSelection(null, placements)).toBe(undefined)
    expect(detailForSelection(undefined, placements)).toBe(undefined)
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
