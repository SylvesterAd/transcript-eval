import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
