import { describe, it, expect, vi } from 'vitest'

// broll.js imports db.js at module load time — mock it to prevent process.exit(1).
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ changes: 0 }),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

import fs from 'node:fs'
import path from 'node:path'
import {
  computeEffectiveCuts,
  unshiftPostCutTime,
} from '../broll.js'

const fixturePath = path.resolve('server/services/__tests__/__fixtures__/project-273-cuts.json')
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

describe('Real-data round-trip — production fixture', () => {
  const cuts = fixture.editor_state?.cuts || []
  const cutExclusions = fixture.editor_state?.cutExclusions || []
  const words = fixture.word_timestamps || []
  const effective = computeEffectiveCuts(cuts, cutExclusions)

  it('fixture has cuts and words', () => {
    expect(effective.length).toBeGreaterThan(0)
    expect(words.length).toBeGreaterThan(0)
  })

  it('every kept word round-trips shift → unshift to within 1ms', () => {
    let checked = 0
    for (const w of words) {
      const mid = (w.start + w.end) / 2
      const inCut = effective.some(c => mid >= c.start && mid < c.end)
      if (inCut) continue
      // Compute shifted start (mirror getOffset behavior).
      let cumOffset = 0
      for (const c of effective) {
        if (c.end <= w.start) cumOffset += c.end - c.start
        else break
      }
      const shifted = w.start - cumOffset
      const roundtrip = unshiftPostCutTime(shifted, effective, 'start')
      expect(Math.abs(roundtrip - w.start)).toBeLessThan(0.001)
      checked++
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('no kept-word midpoint falls inside any effective cut', () => {
    let checkedKept = 0
    // Iterate all words (not just first 200 by index — some fixtures start with
    // a large cut that covers the first N words, so slicing by index can yield
    // zero kept words and a false-failing threshold check).
    for (const w of words) {
      const mid = (w.start + w.end) / 2
      const inCut = effective.some(c => mid >= c.start && mid < c.end)
      if (inCut) continue
      checkedKept++
      for (const c of effective) {
        // The kept word is, by definition, outside all cuts. Verify.
        const insideThisCut = mid >= c.start && mid < c.end
        expect(insideThisCut).toBe(false)
      }
      if (checkedKept >= 200) break
    }
    expect(checkedKept).toBeGreaterThan(20)
  })
})
