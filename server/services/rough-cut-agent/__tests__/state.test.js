import { describe, it, expect } from 'vitest'
import { createState } from '../state.js'

describe('createState', () => {
  it('initialises empty cuts and uncertain arrays', () => {
    const s = createState({ assembledTranscript: 'hi', wordTimestamps: [] })
    expect(s.cuts).toEqual([])
    expect(s.uncertain).toEqual([])
    expect(s.chapters).toBeNull()
  })

  it('addCut appends with monotonic ID', () => {
    const s = createState({ assembledTranscript: '', wordTimestamps: [] })
    const id1 = s.addCut({ start: 0, end: 1, category: 'filler_word', reason: 'um', confidence: 0.9, evidence: ['"um"'] })
    const id2 = s.addCut({ start: 2, end: 3, category: 'meta_commentary', reason: 'aside', confidence: 0.8, evidence: [] })
    expect(id1).toMatch(/^cut_/)
    expect(id2).toMatch(/^cut_/)
    expect(id1).not.toBe(id2)
    expect(s.cuts.length).toBe(2)
  })

  it('removeCut deletes by id', () => {
    const s = createState({ assembledTranscript: '', wordTimestamps: [] })
    const id = s.addCut({ start: 0, end: 1, category: 'filler_word', reason: '', confidence: 0.5, evidence: [] })
    expect(s.removeCut(id)).toBe(true)
    expect(s.cuts.length).toBe(0)
    expect(s.removeCut(id)).toBe(false)
  })

  it('adjustCut updates start/end', () => {
    const s = createState({ assembledTranscript: '', wordTimestamps: [] })
    const id = s.addCut({ start: 0, end: 1, category: 'filler_word', reason: '', confidence: 0.5, evidence: [] })
    expect(s.adjustCut(id, { start: 0.5, end: 1.5 })).toBe(true)
    const cut = s.cuts.find(c => c.id === id)
    expect(cut.start).toBe(0.5)
    expect(cut.end).toBe(1.5)
  })

  it('addUncertain stores reason + range', () => {
    const s = createState({ assembledTranscript: '', wordTimestamps: [] })
    const id = s.addUncertain({ start: 5, end: 6, reason: 'ambiguous' })
    expect(id).toMatch(/^uncertain_/)
    expect(s.uncertain[0].reason).toBe('ambiguous')
  })
})
