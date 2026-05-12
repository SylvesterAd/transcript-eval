import { describe, it, expect } from 'vitest'
import { compareSemver, isOutdated } from '../semver.js'

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('0.0.0', '0.0.0')).toBe(0)
  })

  it('returns -1 when a < b', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1)
    expect(compareSemver('1.2.3', '1.3.0')).toBe(-1)
    expect(compareSemver('1.2.3', '2.0.0')).toBe(-1)
    expect(compareSemver('0.9.0', '0.9.4')).toBe(-1)
    expect(compareSemver('0.9.4', '0.10.0')).toBe(-1)
  })

  it('returns 1 when a > b', () => {
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1)
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1)
  })

  it('throws on malformed input', () => {
    expect(() => compareSemver('1.2', '1.2.3')).toThrow()
    expect(() => compareSemver('1.2.3.4', '1.2.3')).toThrow()
    expect(() => compareSemver('1.x.3', '1.2.3')).toThrow()
    expect(() => compareSemver(null, '1.2.3')).toThrow()
  })
})

describe('isOutdated', () => {
  it('returns true when current < latest', () => {
    expect(isOutdated('0.9.3', '0.9.4')).toBe(true)
    expect(isOutdated('0.9.0', '0.10.0')).toBe(true)
  })

  it('returns false when current >= latest', () => {
    expect(isOutdated('0.9.4', '0.9.4')).toBe(false)
    expect(isOutdated('0.9.5', '0.9.4')).toBe(false)
    expect(isOutdated('1.0.0', '0.9.4')).toBe(false)
  })

  it('returns false on missing inputs (treat unknown as up-to-date)', () => {
    expect(isOutdated(null, '0.9.4')).toBe(false)
    expect(isOutdated('0.9.4', null)).toBe(false)
    expect(isOutdated('', '')).toBe(false)
    expect(isOutdated(undefined, undefined)).toBe(false)
  })

  it('returns false on malformed inputs (never block on parse error)', () => {
    expect(isOutdated('garbage', '0.9.4')).toBe(false)
    expect(isOutdated('0.9.4', 'garbage')).toBe(false)
  })
})
