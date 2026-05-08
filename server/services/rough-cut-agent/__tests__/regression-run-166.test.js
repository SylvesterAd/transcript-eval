import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRANSCRIPT = readFileSync(join(__dirname, '__fixtures__', 'run-166-transcript.txt'), 'utf-8')
const WORDS = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'run-166-words.json'), 'utf-8'))
const ACOUSTIC = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'run-166-acoustic.json'), 'utf-8'))

const DISCOURSE_MARKER_RE = /^(So|Now|Well|Frankly|Of course|Right|And|But)$/

const liveMode = process.env.ANTHROPIC_AGENT_LIVE === '1'

// Stub mode: a recorded happy-path response that obeys the spec. The agent is
// expected to call propose_cut for the keyboard-clacking cluster and avoid
// discourse-marker cuts. We assert the SAME invariants on either mode.
const STUB_AGENT_RESPONSE = {
  cuts: [
    {
      id: 'cut_1',
      start: 7 * 60 + 8.72, end: 7 * 60 + 19.60,
      category: 'meta_commentary',
      reason: 'Keyboard-clacking interruption cluster — speaker pauses to look something up',
      confidence: 0.92,
      evidence: [
        'audio_event: [keyboard clacking] at 7:12.14',
        'cluster: find_interruption_clusters returned span [7:08.72, 7:19.60]',
      ],
    },
  ],
  uncertain: [],
  stopReason: 'finish',
  totalTokens: { in: 50000, out: 1000 },
  toolCalls: 7,
}

// vi.mock would be hoisted above this `if`, silently mocking even in live
// mode. Use `vi.doMock` (executed at runtime, not hoisted) inside beforeAll
// to honor the ANTHROPIC_AGENT_LIVE env var.
beforeAll(async () => {
  if (!liveMode) {
    vi.doMock('../index.js', () => ({
      runAgent: vi.fn().mockResolvedValue(STUB_AGENT_RESPONSE),
    }))
  }
})

// Helper: derive the text being cut by finding all words whose [start,end]
// falls inside the cut span, then strip punctuation.
function textWithinCut(cut, words) {
  const inside = words.filter(w => w.start >= cut.start && w.end <= cut.end && w.type !== 'audio_event')
  return inside.map(w => w.word).join(' ').replace(/[.,!?]/g, '').trim()
}

describe(`regression: run 166 — ${liveMode ? 'LIVE' : 'stubbed'}`, () => {
  let runAgent
  beforeEach(async () => {
    ({ runAgent } = await import('../index.js'))
  })

  it('produces ZERO cuts whose actual cut text is a standalone discourse marker', async () => {
    const r = await runAgent({
      assembledTranscript: TRANSCRIPT,
      wordTimestamps: WORDS,
      model: 'claude-opus-4-7',
    })
    for (const cut of r.cuts) {
      const text = textWithinCut(cut, WORDS)
      if (DISCOURSE_MARKER_RE.test(text)) {
        throw new Error(`discourse-marker mis-cut: text="${text}" cut=${JSON.stringify(cut)}`)
      }
    }
  })

  it('produces AT LEAST ONE meta_commentary cut covering [7:08.72, 7:19.60]', async () => {
    const r = await runAgent({
      assembledTranscript: TRANSCRIPT,
      wordTimestamps: WORDS,
      model: 'claude-opus-4-7',
    })
    const TARGET_START = 7 * 60 + 8.72
    const TARGET_END = 7 * 60 + 19.60
    const covering = r.cuts.find(c =>
      c.category === 'meta_commentary' &&
      c.start <= TARGET_START + 1.0 &&
      c.end >= TARGET_END - 1.0
    )
    expect(covering).toBeDefined()
  })

  it('total tokens stay under 200K input + 50K output (regression test 2)', async () => {
    const r = await runAgent({
      assembledTranscript: TRANSCRIPT,
      wordTimestamps: WORDS,
      model: 'claude-opus-4-7',
    })
    expect(r.totalTokens.in).toBeLessThan(200_000)
    expect(r.totalTokens.out).toBeLessThan(50_000)
  })
})

// Acoustic-feature aggregation regression. Runs deterministically on the
// real librosa output we backfilled to video 509, so failures here mean a
// real change in either librosa output, the aggregator, or feature schema
// — not LLM nondeterminism. Independent of liveMode.
describe('regression: run 166 acoustic features (deterministic)', () => {
  it('content-initiating "All" at t=21s shows a real boundary signal', async () => {
    const { createState } = await import('../state.js')
    const { dispatchTool } = await import('../tools.js')
    const state = createState({
      assembledTranscript: TRANSCRIPT,
      wordTimestamps: WORDS,
      acousticFeatures: ACOUSTIC,
    })
    const r = await dispatchTool('get_acoustic_features', { scope: { start: 18, end: 25 } }, state)
    expect(r.available).toBe(true)
    // The "All" token starts at 21.0 right after a 4s silence gap. The
    // discourse-marker disambiguator wants to KEEP this — the test verifies
    // the boundary signals would actually fire in the agent's decision.
    const allWord = r.words.find(w => w.start === 21 && /^All/.test(w.word))
    expect(allWord).toBeDefined()
    // Pause before should be near-silent (< 0.4 voiced).
    expect(allWord.pause_before_voiced_ratio).toBeLessThan(0.4)
    // Energy in this word should be at speaking levels (loud relative to silence).
    expect(allWord.rms_mean).toBeGreaterThan(-50)
  })

  it('keyboard-clacking cluster span shows low voiced_ratio', async () => {
    const { createState } = await import('../state.js')
    const { dispatchTool } = await import('../tools.js')
    const state = createState({
      assembledTranscript: TRANSCRIPT,
      wordTimestamps: WORDS,
      acousticFeatures: ACOUSTIC,
    })
    const r = await dispatchTool('get_acoustic_features', {
      scope: { start: 7 * 60 + 8.72, end: 7 * 60 + 19.6 },
      granularity: 'frame',
    }, state)
    expect(r.available).toBe(true)
    expect(r.frames.length).toBeGreaterThan(50)
    // The cluster contains [keyboard clacking] + a 2.5s recovery gap.
    // Frames within it should average low rms (mostly quiet / non-speech).
    const meanRms = r.frames.reduce((a, f) => a + f[1], 0) / r.frames.length
    expect(meanRms).toBeLessThan(-40)  // well below normal speaking levels
  })

  it('returns available=false when acousticFeatures is null', async () => {
    const { createState } = await import('../state.js')
    const { dispatchTool } = await import('../tools.js')
    const state = createState({
      assembledTranscript: TRANSCRIPT,
      wordTimestamps: WORDS,
      // no acousticFeatures
    })
    const r = await dispatchTool('get_acoustic_features', {}, state)
    expect(r.available).toBe(false)
  })
})
