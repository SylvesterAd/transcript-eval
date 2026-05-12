// Verifies the export route filters out annotation-source cuts before
// computing a-roll kept segments. Mirrors the same filter used by:
//   - src/components/editor/Timeline.jsx (userCuts)
//   - server/services/broll.js getBRollEditorData (line ~6161)
//
// Without this filter the export's a-roll segmentation includes
// LLM-suggested cuts the user hasn't accepted, producing an XML whose
// first kept clipitem starts later than the rough-cut timeline shows.

import { describe, it, expect } from 'vitest'
import { selectExportCuts } from '../export-xml.js'

describe('selectExportCuts', () => {
  it('strips cuts with source === "annotation" (LLM suggestions)', () => {
    const cuts = [
      { id: 'cut-ann-server-0', source: 'annotation', start: 0, end: 18.55 },
      { id: 'cut-tx-1', source: 'transcript', start: 0.1, end: 4.49 },
      { id: 'cut-ai-silence-1', source: 'ai-silence', start: 1.57, end: 4.29 },
    ]
    const out = selectExportCuts(cuts)
    expect(out).toEqual([
      { id: 'cut-tx-1', source: 'transcript', start: 0.1, end: 4.49 },
      { id: 'cut-ai-silence-1', source: 'ai-silence', start: 1.57, end: 4.29 },
    ])
  })

  it('keeps all non-annotation sources (transcript / ai-silence / unknown)', () => {
    const cuts = [
      { source: 'transcript', start: 0, end: 1 },
      { source: 'ai-silence', start: 2, end: 3 },
      { source: 'manual', start: 4, end: 5 },
      { source: undefined, start: 6, end: 7 },
    ]
    expect(selectExportCuts(cuts)).toEqual(cuts)
  })

  it('returns [] when cuts is null / undefined / not an array', () => {
    expect(selectExportCuts(null)).toEqual([])
    expect(selectExportCuts(undefined)).toEqual([])
    expect(selectExportCuts('nope')).toEqual([])
    expect(selectExportCuts({})).toEqual([])
  })

  it('returns [] when cuts is empty', () => {
    expect(selectExportCuts([])).toEqual([])
  })

  it('tolerates falsy entries inside the array without throwing', () => {
    const cuts = [
      null,
      { source: 'annotation', start: 0, end: 5 },
      { source: 'transcript', start: 5, end: 10 },
      undefined,
    ]
    expect(selectExportCuts(cuts)).toEqual([
      { source: 'transcript', start: 5, end: 10 },
    ])
  })

  it("regression scenario: annotation cut 0→18.55 overlaps user cut 0.1→4.49 — only the user cut survives", () => {
    // Group 367 / video 511: an LLM-emitted [clears throat] annotation
    // claimed endTime=18.22, which cuts-from-annotations extended to
    // 18.55. The user's actual rough-cut content begins at ~4.49s
    // (transcript+ai-silence union). The export was applying the
    // annotation cut, so the first a-roll clipitem started at 18.55s
    // source. The Timeline / b-roll editor were already filtering
    // annotation cuts; the export now does too.
    const cuts = [
      { id: 'cut-ann-server-0', source: 'annotation', start: 0, end: 18.55 },
      { id: 'cut-1778251897094', source: 'transcript', start: 0.1, end: 4.49 },
      { id: 'cut-ai-silence-1', source: 'ai-silence', start: 1.57, end: 4.29 },
    ]
    const out = selectExportCuts(cuts)
    expect(out.find(c => c.source === 'annotation')).toBeUndefined()
    expect(out.map(c => c.id)).toEqual(['cut-1778251897094', 'cut-ai-silence-1'])
  })
})
