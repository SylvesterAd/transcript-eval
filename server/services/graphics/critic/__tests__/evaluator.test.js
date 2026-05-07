// server/services/graphics/critic/__tests__/evaluator.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../lib/llm/gemini.js', () => ({
  callGemini: vi.fn().mockResolvedValue({
    text: '{"score":0.85,"criteria":{"fidelity":0.9,"legibility":0.85,"style":0.8,"timing":0.85},"feedback":"Looks good","retry_recommended":false}',
    toolUses: [],
    tokens: { in: 1200, out: 80 },
    stop: 'STOP',
  }),
}))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, readFile: vi.fn().mockResolvedValue(Buffer.from('fake png')) }
})

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test'
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
    const { callGemini } = await import('../../../../lib/llm/gemini.js')
    callGemini.mockResolvedValueOnce({
      text: 'not json at all',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'STOP',
    })
    const { evaluateFrames } = await import('../evaluator.js')
    await expect(
      evaluateFrames({ framePaths: ['/tmp/f0.png'], spec: { template: 'lower-third' } })
    ).rejects.toThrow(/critic returned invalid JSON/i)
  })

  it('strips markdown fences from gemini responses', async () => {
    const { callGemini } = await import('../../../../lib/llm/gemini.js')
    callGemini.mockResolvedValueOnce({
      text: '```json\n{"score":0.7,"criteria":{"fidelity":0.7,"legibility":0.7,"style":0.7,"timing":0.7},"feedback":"meh","retry_recommended":true}\n```',
      toolUses: [],
      tokens: { in: 100, out: 10 },
      stop: 'STOP',
    })
    const { evaluateFrames } = await import('../evaluator.js')
    const r = await evaluateFrames({ framePaths: ['/tmp/f0.png'], spec: { template: 'lower-third' } })
    expect(r.score).toBe(0.7)
    expect(r.retry_recommended).toBe(true)
  })

  it('passes inlineData parts to callGemini', async () => {
    const { callGemini } = await import('../../../../lib/llm/gemini.js')
    callGemini.mockResolvedValue({
      text: '{"score":0.9,"criteria":{"fidelity":1,"legibility":1,"style":0.8,"timing":0.8},"feedback":"ok","retry_recommended":false}',
      toolUses: [],
      tokens: { in: 0, out: 0 },
      stop: 'STOP',
    })
    const { evaluateFrames } = await import('../evaluator.js')
    await evaluateFrames({
      framePaths: ['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png', '/tmp/f3.png'],
      spec: { template: 'lower-third' },
    })
    const lastCall = callGemini.mock.calls.at(-1)[0]
    expect(lastCall.model).toBe('gemini-3-flash-preview')
    expect(Array.isArray(lastCall.messages[0].content)).toBe(true)
    const parts = lastCall.messages[0].content
    const imageParts = parts.filter((p) => p.inlineData)
    expect(imageParts).toHaveLength(4)
    expect(imageParts[0].inlineData.mimeType).toBe('image/png')
    expect(imageParts[0].inlineData.data).toBe(Buffer.from('fake png').toString('base64'))
  })
})
