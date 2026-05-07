import { describe, it, expect } from 'vitest'
import { buildPaths } from '../StepPath.jsx'

describe('buildPaths', () => {
  it('returns exactly two paths (no guided card)', () => {
    const paths = buildPaths(true)
    expect(paths).toHaveLength(2)
    expect(paths.map(p => p.id)).toEqual(['hands-off', 'strategy-only'])
  })

  it('lists hands-off first with primary tone', () => {
    const paths = buildPaths(true)
    expect(paths[0].id).toBe('hands-off')
    expect(paths[0].tone).toBe('primary')
  })

  it('renames cards to include "+ Rough Cut" when autoRoughCut=true', () => {
    const paths = buildPaths(true)
    expect(paths[0].title).toBe('Auto + Rough Cut')
    expect(paths[1].title).toBe('Strategy + Rough Cut')
  })

  it('uses plain Auto / Strategy titles when autoRoughCut=false', () => {
    const paths = buildPaths(false)
    expect(paths[0].title).toBe('Auto')
    expect(paths[1].title).toBe('Strategy')
  })

  it('hands-off marks rough cut review as optional (highlighted but non-blocking) when autoRoughCut=true', () => {
    const paths = buildPaths(true)
    const handsOff = paths[0]
    const reviewStep = handsOff.flow.find(s => s.label === 'Rough cut review')
    expect(reviewStep).toBeDefined()
    expect(reviewStep.checkpoint).toBeFalsy()
    expect(reviewStep.optional).toBe(true)
  })

  it('strategy-only includes a checkpoint rough cut review step when autoRoughCut=true', () => {
    const paths = buildPaths(true)
    const strategy = paths[1]
    const reviewStep = strategy.flow.find(s => s.label === 'Rough cut review')
    expect(reviewStep).toBeDefined()
    expect(reviewStep.checkpoint).toBe(true)
  })
})
