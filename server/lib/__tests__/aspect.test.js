import { describe, it, expect } from 'vitest'
import { bucketAspect } from '../aspect.js'

describe('bucketAspect', () => {
  it('canonical 16:9 → landscape', () => {
    expect(bucketAspect({ width: 1920, height: 1080 })).toBe('landscape')
  })

  it('canonical 9:16 → portrait', () => {
    expect(bucketAspect({ width: 1080, height: 1920 })).toBe('portrait')
  })

  it('canonical 1:1 → square', () => {
    expect(bucketAspect({ width: 1080, height: 1080 })).toBe('square')
  })

  it('within a few pixels of 16:9 still buckets as landscape', () => {
    // 1922×1080 = 1.7796 vs 16/9 = 1.7778. Linear distance to 1 (square)
    // would beat distance to 1.7778, so a naive |r - target| metric
    // misclassifies as `square`. Log-space keeps it landscape.
    expect(bucketAspect({ width: 1922, height: 1080 })).toBe('landscape')
  })

  it('audio fallback is landscape', () => {
    expect(bucketAspect({ width: null, height: null, mediaType: 'audio' })).toBe('landscape')
    expect(bucketAspect({ width: 0, height: 0, mediaType: 'audio' })).toBe('landscape')
  })

  it('missing dimensions fall back to landscape', () => {
    expect(bucketAspect({})).toBe('landscape')
    expect(bucketAspect({ width: undefined, height: undefined })).toBe('landscape')
    expect(bucketAspect({ width: 1920, height: 0 })).toBe('landscape')
  })
})
