import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db.js', () => ({
  default: { prepare: vi.fn() },
}))

import db from '../../db.js'
import { deriveCutsFromAnnotations, ensureEditorCutsFromAnnotations } from '../cuts-from-annotations.js'

describe('deriveCutsFromAnnotations — pure logic', () => {
  it('returns empty for null/empty annotations', () => {
    expect(deriveCutsFromAnnotations(null)).toEqual([])
    expect(deriveCutsFromAnnotations({})).toEqual([])
    expect(deriveCutsFromAnnotations({ items: [] })).toEqual([])
  })

  it('extracts deletion annotations from cuttable categories', () => {
    const annotations = {
      items: [
        { id: 'a', type: 'deletion', category: 'filler_words', startTime: 10, endTime: 12 },
        { id: 'b', type: 'deletion', category: 'false_starts', startTime: 20, endTime: 25 },
        { id: 'c', type: 'deletion', category: 'meta_commentary', startTime: 30, endTime: 32 },
      ],
    }
    const out = deriveCutsFromAnnotations(annotations)
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ start: 10, end: 12, source: 'annotation' })
    expect(out[1]).toMatchObject({ start: 20, end: 25, source: 'annotation' })
    expect(out[2]).toMatchObject({ start: 30, end: 32, source: 'annotation' })
  })

  it('skips non-deletion annotations and non-cuttable categories', () => {
    const annotations = {
      items: [
        { type: 'deletion', category: 'filler_words', startTime: 0, endTime: 1 },
        { type: 'identify', category: 'filler_words', startTime: 5, endTime: 6 }, // wrong type
        { type: 'deletion', category: 'topic_marker', startTime: 10, endTime: 11 }, // wrong category
        { type: 'deletion', category: 'false_starts', startTime: 20, endTime: 21 },
      ],
    }
    const out = deriveCutsFromAnnotations(annotations)
    expect(out).toHaveLength(2)
    expect(out.map(c => c.start)).toEqual([0, 20])
  })

  it('skips annotations with invalid times', () => {
    const annotations = {
      items: [
        { type: 'deletion', category: 'filler_words', startTime: 'bad', endTime: 1 },
        { type: 'deletion', category: 'filler_words', startTime: 5, endTime: 5 }, // zero duration
        { type: 'deletion', category: 'filler_words', startTime: 10, endTime: 5 }, // inverted
        { type: 'deletion', category: 'filler_words', startTime: 20, endTime: 21 }, // valid
      ],
    }
    expect(deriveCutsFromAnnotations(annotations)).toHaveLength(1)
  })

  it('merges overlapping regions across categories', () => {
    const annotations = {
      items: [
        { type: 'deletion', category: 'filler_words', startTime: 10, endTime: 15 },
        { type: 'deletion', category: 'false_starts', startTime: 14, endTime: 20 },
        { type: 'deletion', category: 'meta_commentary', startTime: 30, endTime: 35 },
      ],
    }
    const out = deriveCutsFromAnnotations(annotations)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ start: 10, end: 20 })
    expect(out[1]).toMatchObject({ start: 30, end: 35 })
  })

  it('subtracts cutExclusions from derived cuts', () => {
    const annotations = {
      items: [
        { type: 'deletion', category: 'filler_words', startTime: 10, endTime: 30 },
      ],
    }
    const exclusions = [{ start: 15, end: 20 }]
    const out = deriveCutsFromAnnotations(annotations, exclusions)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ start: 10, end: 15 })
    expect(out[1]).toMatchObject({ start: 20, end: 30 })
  })

  it('emits source=annotation and stable id pattern', () => {
    const annotations = {
      items: [
        { type: 'deletion', category: 'filler_words', startTime: 10, endTime: 12 },
        { type: 'deletion', category: 'filler_words', startTime: 20, endTime: 22 },
      ],
    }
    const out = deriveCutsFromAnnotations(annotations)
    expect(out[0].source).toBe('annotation')
    expect(out[0].id).toMatch(/^cut-ann-server-/)
    expect(out[1].id).not.toBe(out[0].id) // unique
  })
})

describe('ensureEditorCutsFromAnnotations — DB integration', () => {
  beforeEach(() => { db.prepare.mockReset() })

  it('returns changed=false when no annotations present', async () => {
    db.prepare.mockReturnValueOnce({
      get: () => ({ annotations_json: null, editor_state_json: null })
    })
    const result = await ensureEditorCutsFromAnnotations(123)
    expect(result.changed).toBe(false)
    expect(result.reason).toBe('no_annotations')
  })

  it('writes derived cuts when editor_state has none', async () => {
    const annotations = {
      items: [{ type: 'deletion', category: 'filler_words', startTime: 10, endTime: 12 }],
    }
    let updateCalled = false
    let updatedJson = null
    db.prepare.mockImplementation((sql) => {
      if (sql.includes('SELECT')) {
        return { get: () => ({
          annotations_json: JSON.stringify(annotations),
          editor_state_json: null,
        })}
      }
      if (sql.includes('UPDATE')) {
        return { run: (json, id) => { updateCalled = true; updatedJson = json } }
      }
    })
    const result = await ensureEditorCutsFromAnnotations(123)
    expect(result.changed).toBe(true)
    expect(updateCalled).toBe(true)
    const written = JSON.parse(updatedJson)
    expect(written.cuts).toHaveLength(1)
    expect(written.cuts[0].source).toBe('annotation')
  })

  it('preserves manual cuts and replaces only annotation cuts', async () => {
    const annotations = {
      items: [{ type: 'deletion', category: 'filler_words', startTime: 100, endTime: 105 }],
    }
    const existingState = {
      cuts: [
        { id: 'manual-1', start: 50, end: 55, source: 'transcript' }, // user-made
        { id: 'old-ann', start: 200, end: 210, source: 'annotation' }, // stale
      ],
      cutExclusions: [],
    }
    let updatedJson = null
    db.prepare.mockImplementation((sql) => {
      if (sql.includes('SELECT')) {
        return { get: () => ({
          annotations_json: JSON.stringify(annotations),
          editor_state_json: JSON.stringify(existingState),
        })}
      }
      if (sql.includes('UPDATE')) {
        return { run: (json) => { updatedJson = json } }
      }
    })
    await ensureEditorCutsFromAnnotations(123)
    const written = JSON.parse(updatedJson)
    const manualCuts = written.cuts.filter(c => c.source === 'transcript')
    const annCuts = written.cuts.filter(c => c.source === 'annotation')
    expect(manualCuts).toHaveLength(1)
    expect(manualCuts[0].id).toBe('manual-1') // preserved
    expect(annCuts).toHaveLength(1)
    expect(annCuts[0].start).toBe(100) // new annotation, not the stale one
  })

  it('returns changed=false when annotation cuts already in sync', async () => {
    const annotations = {
      items: [{ type: 'deletion', category: 'filler_words', startTime: 10, endTime: 12 }],
    }
    const existingState = {
      cuts: [{ id: 'cut-ann-server-0', start: 10, end: 12, source: 'annotation' }],
      cutExclusions: [],
    }
    let updateCalled = false
    db.prepare.mockImplementation((sql) => {
      if (sql.includes('SELECT')) {
        return { get: () => ({
          annotations_json: JSON.stringify(annotations),
          editor_state_json: JSON.stringify(existingState),
        })}
      }
      if (sql.includes('UPDATE')) {
        return { run: () => { updateCalled = true } }
      }
    })
    const result = await ensureEditorCutsFromAnnotations(123)
    expect(result.changed).toBe(false)
    expect(result.reason).toBe('already_in_sync')
    expect(updateCalled).toBe(false)
  })
})
