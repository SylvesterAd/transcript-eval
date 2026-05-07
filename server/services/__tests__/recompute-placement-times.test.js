import { describe, it, expect } from 'vitest'
import { recomputePlacementsForCuts } from '../recompute-placement-times.js'

const words = [
  { word: 'a', start: 0, end: 1 },
  { word: 'b', start: 1, end: 2 },
  { word: 'c', start: 5, end: 6 },
  { word: 'd', start: 10, end: 11 },
]

describe('recomputePlacementsForCuts', () => {
  it('recomputes start_seconds + end_seconds preserving duration', () => {
    const placements = [
      { uuid: 'p1', anchor_word_idx: 2, start_seconds: 5, end_seconds: 8, audio_anchor: 'c' },
    ]
    // New cut [2, 4]: original word 'c' at t=5 → post-cut t=3. Duration 3 preserved.
    const newCuts = [{ start: 2, end: 4 }]
    const result = recomputePlacementsForCuts(placements, newCuts, [], words)
    expect(result[0].start_seconds).toBe(3)
    expect(result[0].end_seconds).toBe(6)
    expect(result[0].anchor_orphaned).toBeFalsy()
  })

  it('marks orphaned when anchor_word_idx is null', () => {
    const placements = [{ uuid: 'p1', start_seconds: 5, end_seconds: 8, audio_anchor: 'x' }]
    const result = recomputePlacementsForCuts(placements, [], [], words)
    expect(result[0].anchor_orphaned).toBe(true)
  })

  it('marks anchor_in_cut when anchor word falls inside new cut', () => {
    const placements = [
      { uuid: 'p1', anchor_word_idx: 2, start_seconds: 5, end_seconds: 8, audio_anchor: 'c' },
    ]
    const newCuts = [{ start: 4, end: 8 }]  // contains word 'c' at t=5
    const result = recomputePlacementsForCuts(placements, newCuts, [], words)
    expect(result[0].anchor_in_cut).toBe(true)
  })

  it('preserves placements when cuts list is empty', () => {
    const placements = [
      { uuid: 'p1', anchor_word_idx: 2, start_seconds: 5, end_seconds: 8, audio_anchor: 'c' },
    ]
    const result = recomputePlacementsForCuts(placements, [], [], words)
    expect(result[0].start_seconds).toBe(5)
    expect(result[0].end_seconds).toBe(8)
  })
})
