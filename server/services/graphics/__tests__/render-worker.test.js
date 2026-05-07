import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../events/emitter.js', () => ({ emit: vi.fn() }));

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

vi.mock('../html-generator.js', () => ({
  specToHtml: vi.fn().mockResolvedValue({
    html: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">initial</div></body></html>',
    cost: 5,
    tokens: { in: 600, out: 400 },
  }),
  CREATE_HTML_SYSTEM_PROMPT: 'mock-create-html-system-prompt',
}));

vi.mock('../render-runner.js', () => ({
  renderHtml: vi.fn().mockResolvedValue({
    outputPath: '/tmp/x.mp4',
    bytes: 12345,
    durationMs: 9000,
    workDir: '/tmp/x',
  }),
}));

vi.mock('../uploader.js', () => ({
  uploadRender: vi.fn().mockResolvedValue({ url: 'https://supabase.example/x.mp4' }),
}));

vi.mock('../critic/critic-runner.js', () => ({
  runCritic: vi.fn().mockResolvedValue({
    score: 0.9,                                        // default = passing
    criteria: { fidelity: 0.9, legibility: 0.9, style: 0.9, timing: 0.9 },
    feedback: 'good',
    retry_recommended: false,
    frameUrls: ['https://x/0.png'],
    tokens: { in: 0, out: 0 },
  }),
}));

vi.mock('../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn().mockResolvedValue({
    text: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">retry</div></body></html>',
    toolUses: [],
    tokens: { in: 100, out: 50 },
    stop: 'end_turn',
  }),
}));

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

describe('renderWorker.drainOnce', () => {
  it('claims one queued render, runs it, marks complete', async () => {
    const { drainOnce } = await import('../render-worker.js');
    const { renderHtml } = await import('../render-runner.js');
    const result = await drainOnce();
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
    // Sanity check: renderHtml was called with an html string containing the stage marker
    expect(renderHtml).toHaveBeenCalled();
    const call = renderHtml.mock.calls[0][0];
    expect(typeof call.html).toBe('string');
    expect(call.html).toMatch(/data-composition-id\s*=\s*"main"/i);
  });
});

describe('renderWorker.drainOnce — retry path', () => {
  it('retries up to 2 times when critic score is below threshold, then ships best', async () => {
    // Reset the db sharedGet so claimNextRender returns the queued row again.
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 5, session_id: 1, iteration: 1, template: 'lower-third',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null)

    // Reset runCritic to clear the default and set up 3 failing-then-passing returns.
    const { runCritic } = await import('../critic/critic-runner.js')
    runCritic.mockReset()
    runCritic
      .mockResolvedValueOnce({
        score: 0.4, criteria: { fidelity: 0.4 }, feedback: 'too small',
        retry_recommended: true, frameUrls: ['x'], tokens: { in: 0, out: 0 },
      })
      .mockResolvedValueOnce({
        score: 0.5, criteria: { fidelity: 0.5 }, feedback: 'still small',
        retry_recommended: true, frameUrls: ['x'], tokens: { in: 0, out: 0 },
      })
      .mockResolvedValueOnce({
        score: 0.85, criteria: { fidelity: 0.85 }, feedback: 'good',
        retry_recommended: false, frameUrls: ['x'], tokens: { in: 0, out: 0 },
      })

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    expect(result.errors).toHaveLength(0)
    // 3 critic calls = 3 attempts (initial + 2 retries)
    expect(runCritic).toHaveBeenCalledTimes(3)
  })
});
