import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the SDK at the same path the wrapper at server/lib/llm/anthropic.js uses,
// so the agent's own SDK import resolves to this fake.
const messagesCreateMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: messagesCreateMock },
    })),
  }
})

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  messagesCreateMock.mockReset()
})

const sampleWords = [
  { word: 'Hello', start: 0, end: 1 },
  { word: 'world.', start: 1, end: 2 },
  { word: 'Um,', start: 3, end: 3.4 },
]

describe('runAgent', () => {
  it('does NOT pass thinking config when thinking flag is omitted', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 100, output_tokens: 5 },
      stop_reason: 'end_turn',
    })
    const { runAgent } = await import('../index.js')
    await runAgent({
      assembledTranscript: '[00:00:00] hi',
      wordTimestamps: sampleWords,
      model: 'claude-opus-4-7',
    })
    const apiArgs = messagesCreateMock.mock.calls[0][0]
    expect(apiArgs.thinking).toBeUndefined()
    expect(apiArgs.max_tokens).toBe(4096)
  })

  it('passes thinking config and bumps max_tokens when thinking=true', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'thinking', thinking: 'Let me plan…', signature: 'sig' },
        { type: 'text', text: 'done' },
      ],
      usage: { input_tokens: 100, output_tokens: 5 },
      stop_reason: 'end_turn',
    })
    const { runAgent } = await import('../index.js')
    const r = await runAgent({
      assembledTranscript: '[00:00:00] hi',
      wordTimestamps: sampleWords,
      model: 'claude-opus-4-7',
      thinking: true,
    })
    const apiArgs = messagesCreateMock.mock.calls[0][0]
    expect(apiArgs.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 })
    expect(apiArgs.max_tokens).toBe(16000 + 4096)
    expect(r.thinkingEnabled).toBe(true)
    expect(r.thinkingLog[0].thinking).toContain('Let me plan')
    expect(r.thinkingLog[0].text).toContain('done')
  })

  it('honors custom thinking budget', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    })
    const { runAgent } = await import('../index.js')
    await runAgent({
      assembledTranscript: 'x',
      wordTimestamps: sampleWords,
      model: 'claude-opus-4-7',
      thinking: { budget_tokens: 12000 },
    })
    const apiArgs = messagesCreateMock.mock.calls[0][0]
    expect(apiArgs.thinking).toEqual({ type: 'enabled', budget_tokens: 12000 })
    expect(apiArgs.max_tokens).toBe(12000 + 4096)
  })

  it('terminates when the model returns stop_reason=end_turn (no tool_use)', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Nothing to cut.' }],
      usage: { input_tokens: 100, output_tokens: 5 },
      stop_reason: 'end_turn',
    })
    const { runAgent } = await import('../index.js')
    const r = await runAgent({
      assembledTranscript: '[00:00:00] hi',
      wordTimestamps: sampleWords,
      model: 'claude-opus-4-7',
    })
    expect(r.stopReason).toBe('end_turn')
    expect(r.cuts).toEqual([])
    expect(r.totalTokens.in).toBe(100)
  })

  it('dispatches a propose_cut tool call and feeds tool_result back', async () => {
    messagesCreateMock
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu1', name: 'propose_cut', input: {
            start: 3, end: 3.4, category: 'filler_word',
            reason: 'standalone "Um"', confidence: 0.9, evidence: ['"Um,"'],
          } },
        ],
        usage: { input_tokens: 200, output_tokens: 30 },
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu2', name: 'finish', input: { summary: 'done' } },
        ],
        usage: { input_tokens: 250, output_tokens: 10 },
        stop_reason: 'tool_use',
      })
    const { runAgent } = await import('../index.js')
    const r = await runAgent({
      assembledTranscript: '[00:00:03] Um,',
      wordTimestamps: sampleWords,
      model: 'claude-opus-4-7',
    })
    expect(r.cuts.length).toBe(1)
    expect(r.cuts[0].category).toBe('filler_word')
    expect(r.stopReason).toBe('finish')
    // Two model calls
    expect(messagesCreateMock).toHaveBeenCalledTimes(2)
  })

  it('hard-caps at 100 tool calls', async () => {
    // Always return a propose_cut, never finish — would loop forever without the cap.
    messagesCreateMock.mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'tu', name: 'propose_cut', input: {
          start: 0, end: 0.1, category: 'filler_word',
          reason: 'x', confidence: 0.5, evidence: [],
        } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'tool_use',
    })
    const { runAgent } = await import('../index.js')
    const r = await runAgent({
      assembledTranscript: '[00:00:00] hi',
      wordTimestamps: sampleWords,
      model: 'claude-opus-4-7',
    })
    expect(r.stopReason).toBe('tool_call_limit')
    expect(messagesCreateMock.mock.calls.length).toBeLessThanOrEqual(101)
  })

  it('passes TOOL_SCHEMAS, cached system blocks, and cached transcript on first call', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    })
    const { runAgent } = await import('../index.js')
    await runAgent({
      assembledTranscript: 'hi', wordTimestamps: sampleWords, model: 'claude-opus-4-7',
    })
    const callArgs = messagesCreateMock.mock.calls[0][0]
    expect(Array.isArray(callArgs.tools)).toBe(true)
    const names = callArgs.tools.map(t => t.name)
    expect(names).toContain('propose_cut')
    expect(names).toContain('finish')
    // System is sent as an array of blocks with cache_control
    expect(Array.isArray(callArgs.system)).toBe(true)
    expect(callArgs.system[0].cache_control).toEqual({ type: 'ephemeral' })
    // First user message has the transcript marked for caching
    const firstUserContent = callArgs.messages[0].content
    expect(Array.isArray(firstUserContent)).toBe(true)
    const cachedBlock = firstUserContent.find(b => b.cache_control?.type === 'ephemeral')
    expect(cachedBlock).toBeDefined()
    expect(cachedBlock.text).toBe('hi')
  })
})
