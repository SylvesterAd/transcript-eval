import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 100, output_tokens: 20 },
          stop_reason: 'end_turn',
        }),
      },
    })),
  };
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

describe('anthropic wrapper', () => {
  it('returns text + token counts in normalized shape', async () => {
    const { callAnthropic } = await import('../anthropic.js');
    const r = await callAnthropic({
      model: 'claude-opus-4-7',
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
    });
    expect(r.text).toBe('hello');
    expect(r.tokens.in).toBe(100);
    expect(r.tokens.out).toBe(20);
    expect(r.stop).toBe('end_turn');
  });
});
