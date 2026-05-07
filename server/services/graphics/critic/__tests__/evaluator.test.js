// server/services/graphics/critic/__tests__/evaluator.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn().mockResolvedValue({
    text: '{"score":0.85,"criteria":{"fidelity":0.9,"legibility":0.85,"style":0.8,"timing":0.85},"feedback":"Looks good","retry_recommended":false}',
    toolUses: [],
    tokens: { in: 1200, out: 80 },
    stop: 'end_turn',
  }),
}))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, readFile: vi.fn().mockResolvedValue(Buffer.from('fake png')) }
})

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test'
})

describe('evaluateFrames', () => {
  it('returns parsed critique JSON', async () => {
    const { evaluateFrames } = await import('../evaluator.js')
    const r = await evaluateFrames({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png'],
      spec: { template: 'lower-third', mainText: 'Anna Rivera', tone: 'dramatic' },
    })
    expect(r.score).toBe(0.85)
    expect(r.retry_recommended).toBe(false)
    expect(r.criteria.fidelity).toBe(0.9)
  })

  it('throws on invalid JSON response', async () => {
    const { callAnthropic } = await import('../../../../lib/llm/anthropic.js')
    callAnthropic.mockResolvedValueOnce({
      text: 'not json at all',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'end_turn',
    })
    const { evaluateFrames } = await import('../evaluator.js')
    await expect(
      evaluateFrames({ framePaths: ['/tmp/f0.png'], spec: { template: 'lower-third' } })
    ).rejects.toThrow(/critic returned invalid JSON/i)
  })
})
