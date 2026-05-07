import { describe, it, expect } from 'vitest'
import { sumProbedDurations } from '../UploadConfigFlow.jsx'

// Drives the client-side rough-cut estimate. Returns null whenever the
// total isn't trustworthy (no batch yet, no media in batch, or any entry
// missing a probe result) so StepRoughCut falls back to server polling
// instead of rendering a misleading total.
describe('sumProbedDurations', () => {
  it('returns null when liveFiles is null/undefined', () => {
    expect(sumProbedDurations(null)).toBeNull()
    expect(sumProbedDurations(undefined)).toBeNull()
  })

  it('returns null when liveFiles is empty', () => {
    expect(sumProbedDurations([])).toBeNull()
  })

  it('sums durationSeconds across video entries', () => {
    const liveFiles = [
      { type: 'video', status: 'uploading', durationSeconds: 60 },
      { type: 'video', status: 'complete',  durationSeconds: 120 },
    ]
    expect(sumProbedDurations(liveFiles)).toBe(180)
  })

  it('ignores script entries (only video/audio in the rough-cut scope)', () => {
    const liveFiles = [
      { type: 'video',  status: 'complete', durationSeconds: 60 },
      { type: 'script', status: 'complete', durationSeconds: null },
    ]
    expect(sumProbedDurations(liveFiles)).toBe(60)
  })

  it('ignores errored entries (failed validation, oversized, etc.)', () => {
    const liveFiles = [
      { type: 'video', status: 'complete', durationSeconds: 60 },
      { type: 'video', status: 'error',    durationSeconds: null, error: 'Too large' },
    ]
    expect(sumProbedDurations(liveFiles)).toBe(60)
  })

  it('returns null when ANY non-errored video entry is missing durationSeconds', () => {
    // Probe still in flight or failed for one entry — prefer the server
    // fallback over a partial sum that would mislead.
    const liveFiles = [
      { type: 'video', status: 'uploading', durationSeconds: 60 },
      { type: 'video', status: 'uploading', durationSeconds: null },
    ]
    expect(sumProbedDurations(liveFiles)).toBeNull()
  })

  it('returns null when only errored entries remain (no real media to estimate)', () => {
    const liveFiles = [
      { type: 'video', status: 'error', durationSeconds: null, error: 'Unsupported' },
    ]
    expect(sumProbedDurations(liveFiles)).toBeNull()
  })
})
