import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrepare } = vi.hoisted(() => ({
  mockPrepare: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ changes: 0 }),
    get: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue([]),
  })),
}))
vi.mock('../../db.js', () => ({ default: { prepare: (...a) => mockPrepare(...a) } }))

import { generatePostCutTranscript } from '../broll.js'

const fakeWords = [
  // Cut region: 10–15
  { word: 'Before',  start: 5,  end: 6 },
  { word: 'cut.',    start: 6,  end: 7 },
  { word: 'Inside',  start: 11, end: 12 },  // midpoint 11.5 → cut
  { word: 'cut.',    start: 12, end: 13 },  // midpoint 12.5 → cut
  { word: "Let's",   start: 122.0, end: 122.3 },
  { word: 'clear',   start: 122.3, end: 122.6 },
  { word: 'this.',   start: 122.6, end: 122.9 },
]

beforeEach(() => {
  mockPrepare.mockReset()
  mockPrepare.mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({ word_timestamps_json: JSON.stringify(fakeWords) }),
  }))
})

describe('generatePostCutTranscript (original-time)', () => {
  it('removes words whose midpoint falls inside a cut', async () => {
    const out = await generatePostCutTranscript(123, [{ start: 10, end: 15 }], [])
    expect(out).not.toContain('Inside')
  })

  it('preserves original timecodes on kept words', async () => {
    const out = await generatePostCutTranscript(123, [{ start: 10, end: 15 }], [])
    // First sentence is "Before cut." with start=5
    expect(out).toContain('[00:00:05] Before cut.')
    // "Let's clear this." starts at 122.0 — original time, NOT shifted
    expect(out).toContain("[00:02:02] Let's clear this.")
  })

  it('renders gap markers using original-time differences (cuts are visible as gaps)', async () => {
    const out = await generatePostCutTranscript(123, [{ start: 10, end: 15 }], [])
    // Between "Before cut." (ends 7) and "Let's clear this." (starts 122) there is
    // a 115s gap in original time (cuts are part of that gap).
    expect(out).toContain('[115s]')
  })
})
