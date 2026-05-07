import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRANSCRIPT = readFileSync(join(__dirname, '__fixtures__', 'run-166-transcript.txt'), 'utf-8')
const WORDS = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'run-166-words.json'), 'utf-8'))

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
