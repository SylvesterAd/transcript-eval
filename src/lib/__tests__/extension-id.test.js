import { describe, it, expect } from 'vitest'
import { getExtIdsToProbe } from '../extension-id.js'

describe('getExtIdsToProbe', () => {
  it('returns primary first, then fallbacks', () => {
    expect(getExtIdsToProbe('aaa', ['bbb', 'ccc'])).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('dedupes (primary appearing in fallbacks is dropped from fallbacks)', () => {
    expect(getExtIdsToProbe('aaa', ['aaa', 'bbb'])).toEqual(['aaa', 'bbb'])
    expect(getExtIdsToProbe('aaa', ['bbb', 'bbb'])).toEqual(['aaa', 'bbb'])
  })

  it('skips empty/falsy entries', () => {
    expect(getExtIdsToProbe('aaa', ['', null, 'bbb', undefined])).toEqual(['aaa', 'bbb'])
  })

  it('handles empty primary', () => {
    expect(getExtIdsToProbe('', ['bbb', 'ccc'])).toEqual(['bbb', 'ccc'])
  })

  it('handles missing fallbacks', () => {
    expect(getExtIdsToProbe('aaa', undefined)).toEqual(['aaa'])
    expect(getExtIdsToProbe('aaa', null)).toEqual(['aaa'])
    expect(getExtIdsToProbe('aaa', [])).toEqual(['aaa'])
  })

  it('returns empty when both primary and fallbacks are empty', () => {
    expect(getExtIdsToProbe('', [])).toEqual([])
  })
})
