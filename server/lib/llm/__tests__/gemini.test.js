// server/lib/llm/__tests__/gemini.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMessage = vi.fn()
const startChat = vi.fn(() => ({ sendMessage }))
const getGenerativeModel = vi.fn(() => ({ startChat }))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({ getGenerativeModel })),
}))

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test'
  sendMessage.mockReset()
  startChat.mockClear()
  getGenerativeModel.mockClear()
  sendMessage.mockResolvedValue({
    response: {
      text: () => 'ok',
      functionCalls: () => [],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      candidates: [{ finishReason: 'STOP' }],
    },
  })
})

describe('callGemini', () => {
  it('passes a plain string when content is a string (back-compat)', async () => {
    const { callGemini } = await import('../gemini.js')
    await callGemini({
      model: 'gemini-3-flash-preview',
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(sendMessage).toHaveBeenCalledWith('hi')
  })

  it('passes a parts array when content is an array (multipart)', async () => {
    const { callGemini } = await import('../gemini.js')
    await callGemini({
      model: 'gemini-3-flash-preview',
      system: 'be a critic',
      messages: [
        {
          role: 'user',
          content: [
            { text: 'Score these frames:' },
            { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
            { inlineData: { mimeType: 'image/png', data: 'BBBB' } },
          ],
        },
      ],
    })
    const arg = sendMessage.mock.calls[0][0]
    expect(Array.isArray(arg)).toBe(true)
    expect(arg).toHaveLength(3)
    expect(arg[0]).toEqual({ text: 'Score these frames:' })
    expect(arg[1].inlineData.mimeType).toBe('image/png')
    expect(arg[1].inlineData.data).toBe('AAAA')
  })

  it('returns normalized shape', async () => {
    const { callGemini } = await import('../gemini.js')
    const r = await callGemini({
      model: 'gemini-3-flash-preview',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(r.text).toBe('ok')
    expect(r.tokens).toEqual({ in: 10, out: 5 })
    expect(r.stop).toBe('STOP')
  })
})
