import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../events/emitter.js', () => ({ emit: vi.fn() }));

// Correction #1: paths use 3-up traversal (__tests__ → graphics → services → server)
vi.mock('../../../lib/llm/gemini.js', () => ({
  callGemini: vi.fn().mockResolvedValue({
    text: 'What aspect ratio?\n[SPEC]{"template":"lower-third"}',
    toolUses: [],
    tokens: { in: 500, out: 50 },
    stop: 'STOP',
  }),
}));
vi.mock('../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn(),
}));
// Correction #2: db.js default export — mock with { default: { prepare, transaction } }
vi.mock('../../../db.js', () => {
  const prepareMock = vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn().mockResolvedValue({ id: 1, spec_json: {}, status: 'briefing' }),
    all: vi.fn().mockResolvedValue([]),
  }));
  return {
    default: {
      prepare: prepareMock,
      transaction: vi.fn(async (fn) => fn({ prepare: prepareMock })),
    },
  };
});

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test';
});

describe('orchestrator', () => {
  it('extracts [SPEC] block from assistant reply and merges into session', async () => {
    const { runChatTurn } = await import('../orchestrator.js');
    const result = await runChatTurn({ sessionId: 1, userMessage: 'I want a lower-third' });
    expect(result.assistantText).toContain('What aspect ratio?');
    expect(result.assistantText).not.toContain('[SPEC]');  // strip check
    expect(result.specUpdate).toEqual({ template: 'lower-third' });
  });

  it('passes Google Search grounding tools on the brief callGemini call', async () => {
    const { callGemini } = await import('../../../lib/llm/gemini.js')
    callGemini.mockClear()
    callGemini.mockResolvedValue({
      text: '[SPEC]{"template":"lower-third"}',
      toolUses: [],
      tokens: { in: 100, out: 10 },
      stop: 'STOP',
    })
    const { runChatTurn } = await import('../orchestrator.js')
    await runChatTurn({ sessionId: 1, userMessage: 'use the WSJ logo' })
    const lastCall = callGemini.mock.calls.at(-1)[0]
    expect(lastCall.tools).toEqual([{ googleSearch: {} }])
    expect(lastCall.model).toBe('gemini-3-flash-preview')
  })
});

describe('BRIEF_SYSTEM_PROMPT documents available adapters', () => {
  it('lists gsap, lottie, three, animejs, waapi, css-animations as adapter options', async () => {
    const { BRIEF_SYSTEM_PROMPT } = await import('../brief-prompt.js')
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/gsap/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/lottie/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/three/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/animejs|anime\.js/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/waapi|web animations/i)
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/css-animations|css animation/i)
  })
})
