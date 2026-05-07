import { describe, it, expect, vi, beforeEach } from 'vitest';

// All test paths are 3-up: __tests__ → graphics → services → server
vi.mock('../../../db.js', () => {
  const queued = [
    {
      id: 5,
      session_id: 1,
      iteration: 1,
      template: 'lower-third',
      spec_snapshot_json: {
        template: 'lower-third',
        mainText: 'Hi',
        subText: 'Sub',
        aspectRatio: '16:9',
        duration: 5,
        tone: 'neutral',
      },
    },
  ];

  // A SHARED get mock: first call returns the queued row, all subsequent
  // calls return null (queue empty). Must be shared so every db.prepare()
  // call inside claimNextRender() drains from the same counter — if a new
  // vi.fn() were created per prepare() call, mockResolvedValueOnce would
  // reset on every iteration and loop forever.
  const sharedGet = vi.fn()
    .mockResolvedValueOnce(queued[0])
    .mockResolvedValue(null);

  const prepareMock = vi.fn(() => ({
    run: vi.fn().mockResolvedValue({ lastInsertRowid: null, changes: 1 }),
    get: sharedGet,
    all: vi.fn().mockResolvedValue([]),
  }));
  return {
    default: {
      prepare: prepareMock,
      transaction: vi.fn(async (fn) => fn({ prepare: prepareMock })),
    },
  };
});

vi.mock('../render-runner.js', () => ({
  renderTemplate: vi.fn().mockResolvedValue({
    outputPath: '/tmp/x.mp4',
    bytes: 12345,
    durationMs: 9000,
    workDir: '/tmp/x',
  }),
}));

vi.mock('../uploader.js', () => ({
  uploadRender: vi.fn().mockResolvedValue({ url: 'https://supabase.example/x.mp4' }),
}));

vi.mock('../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn().mockResolvedValue({
    text: '{"width":1920,"height":1080,"duration":5,"mainText":"Hi","subText":"Sub","accent":"#9ca3af","barBottom":80,"barLeft":80,"barHeight":120,"barMaxWidth":1056,"mainSize":48,"subSize":18}',
    toolUses: [],
    tokens: { in: 800, out: 100 },
    stop: 'end_turn',
  }),
}));

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

describe('renderWorker.drainOnce', () => {
  it('claims one queued render, runs it, marks complete', async () => {
    const { drainOnce } = await import('../render-worker.js');
    const result = await drainOnce();
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
