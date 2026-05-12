import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../events/emitter.js', () => ({ emit: vi.fn() }));

vi.mock('../lint-runner.js', () => ({
  runLint: vi.fn().mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] }),
  formatFindingsForPrompt: vi.fn((findings) => {
    if (!findings || findings.length === 0) return '';
    return `Lint findings:\n${findings.map((f) => `- [${(f.severity ?? 'error').toUpperCase()}] ${f.rule ?? 'lint'}: ${f.message}`).join('\n')}`;
  }),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    default: {
      ...actual.default,
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

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
  refineHtml: vi.fn().mockResolvedValue({
    html: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">refined</div></body></html>',
    cost: 3,
    tokens: { in: 800, out: 600 },
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

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    specToHtml.mockClear()
    refineHtml.mockClear()

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    expect(result.errors).toHaveLength(0)
    // 3 critic calls = 3 attempts (initial + 2 retries)
    expect(runCritic).toHaveBeenCalledTimes(3)
    // specToHtml only on iteration 0; refineHtml on iterations 1 and 2
    expect(specToHtml).toHaveBeenCalledTimes(1)
    expect(refineHtml).toHaveBeenCalledTimes(2)
  })
});

describe('renderWorker.drainOnce — critic-loop refinement', () => {
  it('calls refineHtml (not specToHtml) when critic recommends retry', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 99, session_id: 'sess-99', iteration: 1, template: 'lower-third',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Test', subText: 'Subtext',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null)

    const { runLint } = await import('../lint-runner.js')
    runLint.mockReset()
    runLint.mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] })

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    specToHtml.mockClear()
    specToHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div data-composition-id="main">v1</div></body></html>',
      cost: 1,
      tokens: { in: 100, out: 100 },
    })
    refineHtml.mockClear()
    refineHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div data-composition-id="main">v2</div></body></html>',
      cost: 1,
      tokens: { in: 100, out: 100 },
    })

    const { runCritic } = await import('../critic/critic-runner.js')
    runCritic.mockReset()
    runCritic
      .mockResolvedValueOnce({
        score: 0.5, criteria: {},
        feedback: 'Lower-third bar moves too fast; extend hold to 4s',
        retry_recommended: true, frameUrls: [], tokens: { in: 50, out: 50 },
      })
      .mockResolvedValueOnce({
        score: 0.95, criteria: {},
        feedback: 'much better',
        retry_recommended: false, frameUrls: [], tokens: { in: 50, out: 50 },
      })

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    expect(result.errors).toHaveLength(0)
    expect(specToHtml).toHaveBeenCalledTimes(1) // only iteration 0
    expect(refineHtml).toHaveBeenCalledTimes(1) // iteration 1 retry
    const refineCall = refineHtml.mock.calls[0][0]
    expect(refineCall.html).toContain('v1')
    expect(refineCall.feedback).toMatch(/extend hold to 4s/i)
    expect(refineCall.spec).toBeDefined()
    expect(refineCall.spec.template).toBe('lower-third')
  })
});

describe('renderWorker.drainOnce — lint gate', () => {
  it('lint clean: runs runLint once, specToHtml once, proceeds to renderHtml', async () => {
    const db = (await import('../../../db.js')).default;
    const sharedGet = db.prepare().get;
    sharedGet.mockReset();
    sharedGet
      .mockResolvedValueOnce({
        id: 11, session_id: 4, iteration: 1, template: 'lower-third',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null);

    const { runLint } = await import('../lint-runner.js');
    const { specToHtml } = await import('../html-generator.js');
    const { renderHtml } = await import('../render-runner.js');
    const { runCritic } = await import('../critic/critic-runner.js');

    runLint.mockReset();
    runLint.mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] });

    specToHtml.mockClear();
    renderHtml.mockClear();

    runCritic.mockReset();
    runCritic.mockResolvedValue({
      score: 0.9, criteria: { fidelity: 0.9, legibility: 0.9, style: 0.9, timing: 0.9 },
      feedback: 'good', retry_recommended: false, frameUrls: ['x'], tokens: { in: 0, out: 0 },
    });

    const { drainOnce } = await import('../render-worker.js');
    const result = await drainOnce();

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(runLint).toHaveBeenCalledTimes(1);
    expect(specToHtml).toHaveBeenCalledTimes(1);
    expect(renderHtml).toHaveBeenCalled();
  });

  it('lint dirty then clean: retries specToHtml with additionalSystemContext, then proceeds', async () => {
    const db = (await import('../../../db.js')).default;
    const sharedGet = db.prepare().get;
    sharedGet.mockReset();
    sharedGet
      .mockResolvedValueOnce({
        id: 12, session_id: 5, iteration: 1, template: 'lower-third',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null);

    const { runLint } = await import('../lint-runner.js');
    const { specToHtml } = await import('../html-generator.js');
    const { renderHtml } = await import('../render-runner.js');
    const { runCritic } = await import('../critic/critic-runner.js');

    runLint.mockReset();
    runLint
      .mockResolvedValueOnce({
        errorCount: 2, warningCount: 0, infoCount: 0,
        findings: [{ severity: 'error', rule: 'determinism', message: 'Math.random' }],
      })
      .mockResolvedValueOnce({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] });

    specToHtml.mockClear();
    specToHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>',
      cost: 5,
      tokens: { in: 600, out: 400 },
    });

    renderHtml.mockClear();
    runCritic.mockReset();
    runCritic.mockResolvedValue({
      score: 0.9, criteria: { fidelity: 0.9, legibility: 0.9, style: 0.9, timing: 0.9 },
      feedback: 'good', retry_recommended: false, frameUrls: ['x'], tokens: { in: 0, out: 0 },
    });

    const { drainOnce } = await import('../render-worker.js');
    const result = await drainOnce();

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(runLint).toHaveBeenCalledTimes(2);
    expect(specToHtml).toHaveBeenCalledTimes(2);
    // First call: no additionalSystemContext (or null/undefined)
    const firstCall = specToHtml.mock.calls[0][0];
    expect(firstCall.additionalSystemContext == null).toBe(true);
    // Second call: WITH additionalSystemContext containing the finding
    const secondCall = specToHtml.mock.calls[1][0];
    expect(typeof secondCall.additionalSystemContext).toBe('string');
    expect(secondCall.additionalSystemContext).toMatch(/determinism/);
    expect(secondCall.additionalSystemContext).toMatch(/Math\.random/);
    expect(renderHtml).toHaveBeenCalled();
  });

  it('on lint failure, the persisted error_message includes a head+tail preview of the actual HTML', async () => {
    const db = (await import('../../../db.js')).default;
    const sharedGet = db.prepare().get;
    sharedGet.mockReset();
    sharedGet
      .mockResolvedValueOnce({
        id: 19, session_id: 10, iteration: 1, template: 'lower-third',
        parent_render_id: null,
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null);

    const { runLint } = await import('../lint-runner.js');
    const { specToHtml } = await import('../html-generator.js');
    runLint.mockReset();
    runLint.mockResolvedValue({
      errorCount: 1, warningCount: 0, infoCount: 0,
      findings: [{ severity: 'error', rule: 'missing_timeline_registry', message: 'no __timelines' }],
    });
    const broken =
      '<!doctype html><html><head><title>BROKEN_HEAD_MARKER</title></head>' +
      '<body><div data-composition-id="main">scene-content</div>' +
      '<!-- BROKEN_TAIL_MARKER -->\n<script>const tl = gsap.timeline({ paused: true });</script>' +
      '</body></html>';
    specToHtml.mockClear();
    specToHtml.mockResolvedValue({ html: broken, cost: 5, tokens: { in: 600, out: 400 } });

    const origTransaction = db.transaction;
    const txCalls = [];
    db.transaction = async (fn) =>
      fn({
        prepare: (sql) => ({
          run: (...args) => {
            txCalls.push({ sql, args });
            return { changes: 1 };
          },
          get: (...args) => {
            txCalls.push({ sql, args });
            return null;
          },
        }),
      });

    try {
      const { drainOnce } = await import('../render-worker.js');
      await drainOnce();
      const renderFailedUpdate = txCalls.find(
        (c) => /UPDATE graphics_renders/.test(c.sql) && /status\s*=\s*'failed'/.test(c.sql)
      );
      expect(renderFailedUpdate).toBeDefined();
      const errorBody = renderFailedUpdate.args[0];
      expect(errorBody).toMatch(/lint failed after \d+ retries/);
      expect(errorBody).toContain('FAILED HTML');
      // Both ends of the failed HTML are inlined (head + tail) so we can
      // diagnose without Railway's /tmp.
      expect(errorBody).toContain('BROKEN_HEAD_MARKER');
      expect(errorBody).toContain('BROKEN_TAIL_MARKER');
    } finally {
      db.transaction = origTransaction;
    }
  });

  it('formatFailedHtmlPreview returns empty string for empty/non-string input', async () => {
    const { formatFailedHtmlPreview } = await import('../render-worker.js');
    expect(formatFailedHtmlPreview(null)).toBe('');
    expect(formatFailedHtmlPreview(undefined)).toBe('');
    expect(formatFailedHtmlPreview('')).toBe('');
    expect(formatFailedHtmlPreview(42)).toBe('');
  });

  it('formatFailedHtmlPreview inlines full HTML when small, head+tail when large', async () => {
    const { formatFailedHtmlPreview } = await import('../render-worker.js');
    const small = 'a'.repeat(500);
    const smallOut = formatFailedHtmlPreview(small);
    expect(smallOut).toContain('500 chars total');
    expect(smallOut).toContain(small);

    const large = 'H'.repeat(2000) + 'M'.repeat(5000) + 'T'.repeat(2000);
    const largeOut = formatFailedHtmlPreview(large);
    expect(largeOut).toContain(`${large.length} chars`);
    expect(largeOut).toContain('truncated middle');
    expect(largeOut).toContain('H'.repeat(1500));
    expect(largeOut).toContain('T'.repeat(1500));
    expect(largeOut).not.toContain('M'.repeat(2000));
  });

  it('lint dirty TWICE then clean: takes a second retry before proceeding (LINT_MAX_RETRIES=2)', async () => {
    const db = (await import('../../../db.js')).default;
    const sharedGet = db.prepare().get;
    sharedGet.mockReset();
    sharedGet
      .mockResolvedValueOnce({
        id: 18, session_id: 9, iteration: 1, template: 'lower-third',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null);

    const { runLint } = await import('../lint-runner.js');
    const { specToHtml } = await import('../html-generator.js');
    const { renderHtml } = await import('../render-runner.js');
    const { runCritic } = await import('../critic/critic-runner.js');

    runLint.mockReset();
    runLint
      .mockResolvedValueOnce({
        errorCount: 1, warningCount: 0, infoCount: 0,
        findings: [{ severity: 'error', rule: 'missing_timeline', message: 'no __timelines' }],
      })
      .mockResolvedValueOnce({
        errorCount: 1, warningCount: 0, infoCount: 0,
        findings: [{ severity: 'error', rule: 'missing_timeline', message: 'still no __timelines' }],
      })
      .mockResolvedValueOnce({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] });

    specToHtml.mockClear();
    specToHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>',
      cost: 5,
      tokens: { in: 600, out: 400 },
    });

    renderHtml.mockClear();
    runCritic.mockReset();
    runCritic.mockResolvedValue({
      score: 0.9, criteria: { fidelity: 0.9, legibility: 0.9, style: 0.9, timing: 0.9 },
      feedback: 'good', retry_recommended: false, frameUrls: ['x'], tokens: { in: 0, out: 0 },
    });

    const { drainOnce } = await import('../render-worker.js');
    const result = await drainOnce();

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
    // initial + retry 1 + retry 2 (clean on retry 2)
    expect(runLint).toHaveBeenCalledTimes(3);
    expect(specToHtml).toHaveBeenCalledTimes(3);
    // Both retries get the lint feedback as additionalSystemContext
    expect(specToHtml.mock.calls[1][0].additionalSystemContext).toMatch(/missing_timeline/);
    expect(specToHtml.mock.calls[2][0].additionalSystemContext).toMatch(/still no __timelines/);
    expect(renderHtml).toHaveBeenCalled();
  });

  it('lint still dirty after retry: marks render failed, does not call renderHtml', async () => {
    const db = (await import('../../../db.js')).default;
    const sharedGet = db.prepare().get;
    sharedGet.mockReset();
    sharedGet
      .mockResolvedValueOnce({
        id: 13, session_id: 6, iteration: 1, template: 'lower-third',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null);

    const { runLint } = await import('../lint-runner.js');
    const { specToHtml } = await import('../html-generator.js');
    const { renderHtml } = await import('../render-runner.js');

    runLint.mockReset();
    runLint.mockResolvedValue({
      errorCount: 1, warningCount: 0, infoCount: 0,
      findings: [{ severity: 'error', rule: 'determinism', message: 'Math.random still present' }],
    });

    specToHtml.mockClear();
    specToHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>',
      cost: 5,
      tokens: { in: 600, out: 400 },
    });

    renderHtml.mockClear();

    // Capture the failure-marking UPDATE call. The catch block now wraps
    // failure marking in db.transaction — override it so inner tx.prepare
    // calls route through the spy.
    const origTransaction = db.transaction;
    db.transaction = async (fn) => fn({ prepare: (...args) => db.prepare(...args) });
    const prepareSpy = vi.spyOn(db, 'prepare');

    try {
      const { drainOnce } = await import('../render-worker.js');
      const result = await drainOnce();

      expect(result.processed).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/lint failed/i);
      // Initial attempt + LINT_MAX_RETRIES (=2) retries = 3 lint runs total
      expect(runLint).toHaveBeenCalledTimes(3);
      expect(renderHtml).not.toHaveBeenCalled();
      // The failure-marking SQL should have been prepared
      const sqls = prepareSpy.mock.calls.map((c) => c[0]);
      const failedMark = sqls.find((s) => /UPDATE graphics_renders/.test(s) && /status\s*=\s*'failed'/.test(s));
      expect(failedMark).toBeDefined();
      // And the session must be unstuck — for an initial render (no
      // parent_render_id) it flips back to 'briefing' so the user isn't
      // permanently locked out of the chat UI.
      const sessionStatusUpdate = sqls.find(
        (s) => /UPDATE graphics_sessions/.test(s) && /SET status/.test(s)
      );
      expect(sessionStatusUpdate).toBeDefined();
    } finally {
      prepareSpy.mockRestore();
      db.transaction = origTransaction;
    }
  });

  it('on iteration render failure (parent_render_id set), session flips to iterating not briefing', async () => {
    const db = (await import('../../../db.js')).default;
    const sharedGet = db.prepare().get;
    sharedGet.mockReset();
    sharedGet
      .mockResolvedValueOnce({
        id: 14, session_id: 7, iteration: 2, template: 'lower-third',
        parent_render_id: 99,  // <-- iteration off a parent
        spec_snapshot_json: { template: 'lower-third', mainText: 'Hi', subText: 'Sub', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValue(null);

    // Force failure inside the critic loop by making specToHtml throw — both
    // initial-render and iteration paths share the same outer catch block.
    const { specToHtml } = await import('../html-generator.js');
    specToHtml.mockClear();
    specToHtml.mockRejectedValue(new Error('synthetic failure for test'));

    const origTransaction = db.transaction;
    const txCalls = [];
    db.transaction = async (fn) =>
      fn({
        prepare: (sql) => ({
          run: (...args) => {
            txCalls.push({ sql, args });
            return { changes: 1 };
          },
          get: (...args) => {
            txCalls.push({ sql, args });
            return null;
          },
        }),
      });

    try {
      const { drainOnce } = await import('../render-worker.js');
      await drainOnce();
      const statusUpdate = txCalls.find(
        (c) => /UPDATE graphics_sessions/.test(c.sql) && /SET status/.test(c.sql)
      );
      expect(statusUpdate).toBeDefined();
      // The first positional arg is the next status value (parameterised)
      expect(statusUpdate.args[0]).toBe('iterating');
    } finally {
      db.transaction = origTransaction;
    }
  });

  it('on initial render failure (no parent_render_id), session flips to briefing', async () => {
    const db = (await import('../../../db.js')).default;
    const sharedGet = db.prepare().get;
    sharedGet.mockReset();
    sharedGet
      .mockResolvedValueOnce({
        id: 15, session_id: 8, iteration: 1, template: 'lower-third',
        parent_render_id: null,  // <-- initial render
        spec_snapshot_json: { template: 'lower-third', mainText: 'Hi', subText: 'Sub', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValue(null);

    const { specToHtml } = await import('../html-generator.js');
    specToHtml.mockClear();
    specToHtml.mockRejectedValue(new Error('synthetic failure for test'));

    const origTransaction = db.transaction;
    const txCalls = [];
    db.transaction = async (fn) =>
      fn({
        prepare: (sql) => ({
          run: (...args) => {
            txCalls.push({ sql, args });
            return { changes: 1 };
          },
          get: (...args) => {
            txCalls.push({ sql, args });
            return null;
          },
        }),
      });

    try {
      const { drainOnce } = await import('../render-worker.js');
      await drainOnce();
      const statusUpdate = txCalls.find(
        (c) => /UPDATE graphics_sessions/.test(c.sql) && /SET status/.test(c.sql)
      );
      expect(statusUpdate).toBeDefined();
      expect(statusUpdate.args[0]).toBe('briefing');
    } finally {
      db.transaction = origTransaction;
    }
  });
});

describe('drainOnce — multi-scene single-render flow', () => {
  it('produces ONE render for a multi-scene spec; critic returns aggregate score', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 100, session_id: 's-100',
        spec_snapshot_json: {
          aspectRatio: '16:9', tone: 'analytical',
          scenes: [
            { template: 'opener', duration: 3, mainText: 'A', subText: 'kicker' },
            { template: 'stat', duration: 4, mainText: '187', subText: 'PCT' },
            { template: 'cta', duration: 4, mainText: 'READ' },
          ],
        },
        iteration_count: 0,
      })
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    const { renderHtml } = await import('../render-runner.js')
    const { runCritic } = await import('../critic/critic-runner.js')
    const { runLint } = await import('../lint-runner.js')
    const { uploadRender } = await import('../uploader.js')

    runLint.mockReset()
    runLint.mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] })

    specToHtml.mockClear()
    specToHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="11">' +
        '<div class="scene clip" id="s1" data-start="0" data-duration="3"></div>' +
        '<div class="scene clip" id="s2" data-start="3" data-duration="4"></div>' +
        '<div class="scene clip" id="s3" data-start="7" data-duration="4"></div>' +
        '</div></body></html>',
      cost: 1, tokens: { in: 100, out: 100 },
    })
    refineHtml.mockClear()
    renderHtml.mockClear()
    renderHtml.mockResolvedValue({ outputPath: '/tmp/out.mp4', durationMs: 200 })
    uploadRender.mockClear()
    uploadRender.mockResolvedValue({ url: 'http://supa/r.mp4' })

    runCritic.mockReset()
    runCritic.mockResolvedValue({
      score: 0.85, criteria: {}, feedback: 'Scene 1: ok\nScene 2: ok\nScene 3: ok',
      retry_recommended: false, frameUrls: [], tokens: { in: 50, out: 50 },
    })

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    expect(specToHtml).toHaveBeenCalledTimes(1)
    expect(renderHtml).toHaveBeenCalledTimes(1)
    expect(runCritic).toHaveBeenCalledTimes(1)
    expect(refineHtml).not.toHaveBeenCalled()
  })

  it('refines once when critic returns low score with scene-scoped feedback', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 101, session_id: 's-101',
        spec_snapshot_json: {
          aspectRatio: '16:9', tone: 'neutral',
          scenes: [
            { template: 'lower-third', duration: 5, mainText: 'A', subText: 'a' },
            { template: 'lower-third', duration: 5, mainText: 'B', subText: 'b' },
          ],
        },
        iteration_count: 0,
      })
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    const { renderHtml } = await import('../render-runner.js')
    const { runCritic } = await import('../critic/critic-runner.js')
    const { runLint } = await import('../lint-runner.js')
    const { uploadRender } = await import('../uploader.js')

    runLint.mockReset()
    runLint.mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] })

    specToHtml.mockClear()
    specToHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="10">v1</div></body></html>',
      cost: 1, tokens: { in: 100, out: 100 },
    })
    refineHtml.mockClear()
    refineHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="10">v2</div></body></html>',
      cost: 1, tokens: { in: 100, out: 100 },
    })
    renderHtml.mockClear()
    renderHtml.mockResolvedValue({ outputPath: '/tmp/out.mp4', durationMs: 200 })
    uploadRender.mockClear()
    uploadRender.mockResolvedValue({ url: 'http://supa/r.mp4' })

    runCritic.mockReset()
    runCritic
      .mockResolvedValueOnce({ score: 0.5, criteria: {}, feedback: 'Scene 1: too fast\nScene 2: ok', retry_recommended: true, frameUrls: [], tokens: { in: 50, out: 50 } })
      .mockResolvedValueOnce({ score: 0.95, criteria: {}, feedback: 'Scene 1: better\nScene 2: ok', retry_recommended: false, frameUrls: [], tokens: { in: 50, out: 50 } })

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    expect(specToHtml).toHaveBeenCalledTimes(1)
    expect(refineHtml).toHaveBeenCalledTimes(1)
    expect(runCritic).toHaveBeenCalledTimes(2)
    expect(renderHtml).toHaveBeenCalledTimes(2)

    const refineArgs = refineHtml.mock.calls[0][0]
    expect(refineArgs.feedback).toMatch(/Scene 1: too fast/)
    expect(refineArgs.feedback).toMatch(/Scene 2: ok/)
  })
});

describe('renderWorker.drainOnce — refine-from-parent path', () => {
  it('uses refineHtml(parent_final_html, human_feedback, spec) when parent_render_id is set', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      // 1st call: claimNextRender returns a row with parent_render_id set
      .mockResolvedValueOnce({
        id: 300, session_id: 's-300', iteration: 2, template: 'lower-third',
        parent_render_id: 200,
        human_feedback: 'make the title bigger',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      // 2nd call: parent lookup returns parent's final_html_text
      .mockResolvedValueOnce({
        final_html_text: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="5">PARENT</div></body></html>',
      })
      // subsequent calls: queue empty
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    const { runLint } = await import('../lint-runner.js')
    const { renderHtml } = await import('../render-runner.js')
    const { runCritic } = await import('../critic/critic-runner.js')
    const { uploadRender } = await import('../uploader.js')

    specToHtml.mockClear()
    refineHtml.mockClear()
    refineHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="5">REFINED</div></body></html>',
      cost: 2, tokens: { in: 200, out: 300 },
    })
    runLint.mockReset()
    runLint.mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] })
    renderHtml.mockClear()
    renderHtml.mockResolvedValue({ outputPath: '/tmp/x.mp4', durationMs: 1000 })
    uploadRender.mockClear()
    uploadRender.mockResolvedValue({ url: 'http://supa/x.mp4' })
    runCritic.mockReset()
    runCritic.mockResolvedValue({
      score: 0.9, criteria: {}, feedback: 'good',
      retry_recommended: false, frameUrls: [], tokens: { in: 0, out: 0 },
    })

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    expect(result.errors).toHaveLength(0)
    // The refine path bypasses specToHtml entirely
    expect(specToHtml).not.toHaveBeenCalled()
    // refineHtml gets called with parent's HTML + user feedback + spec
    expect(refineHtml).toHaveBeenCalledTimes(1)
    const refineCall = refineHtml.mock.calls[0][0]
    expect(refineCall.html).toMatch(/PARENT/)
    expect(refineCall.feedback).toBe('make the title bigger')
    expect(refineCall.spec.template).toBe('lower-third')
  })

  it('marks render failed when parent has no final_html_text', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 301, session_id: 's-301', iteration: 2, template: 'lower-third',
        parent_render_id: 201,
        human_feedback: 'change something',
        spec_snapshot_json: { template: 'lower-third', mainText: 'X', subText: 'Y', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValueOnce({ final_html_text: null })
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    specToHtml.mockClear(); refineHtml.mockClear()

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()
    expect(result.processed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toMatch(/missing final_html_text/i)
    expect(refineHtml).not.toHaveBeenCalled()
  })

  it('marks render failed when human_feedback is missing despite parent_render_id', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 302, session_id: 's-302', iteration: 2, template: 'lower-third',
        parent_render_id: 202,
        human_feedback: null,
        spec_snapshot_json: { template: 'lower-third', mainText: 'X', subText: 'Y', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValueOnce({ final_html_text: '<!doctype html><div data-composition-id="main">P</div>' })
      .mockResolvedValue(null)

    const { refineHtml } = await import('../html-generator.js')
    refineHtml.mockClear()

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()
    expect(result.processed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toMatch(/no human_feedback/i)
    expect(refineHtml).not.toHaveBeenCalled()
  })

  it('marks render failed when refined HTML fails lint (no retry on this path)', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 303, session_id: 's-303', iteration: 2, template: 'lower-third',
        parent_render_id: 203,
        human_feedback: 'something',
        spec_snapshot_json: { template: 'lower-third', mainText: 'X', subText: 'Y', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValueOnce({
        final_html_text: '<!doctype html><div data-composition-id="main">P</div>',
      })
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    const { runLint } = await import('../lint-runner.js')
    const { renderHtml } = await import('../render-runner.js')
    specToHtml.mockClear()
    refineHtml.mockClear()
    refineHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div data-composition-id="main">USES_MATH_RANDOM</div></body></html>',
      cost: 1, tokens: { in: 50, out: 50 },
    })
    runLint.mockReset()
    runLint.mockResolvedValue({
      errorCount: 1, warningCount: 0, infoCount: 0,
      findings: [{ severity: 'error', rule: 'determinism', message: 'Math.random' }],
    })
    renderHtml.mockClear()

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()
    expect(result.processed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toMatch(/refined HTML failed lint/i)
    // refine was called once; lint was called ONCE (no retry); renderHtml never reached
    expect(refineHtml).toHaveBeenCalledTimes(1)
    expect(runLint).toHaveBeenCalledTimes(1)
    expect(renderHtml).not.toHaveBeenCalled()
  })

  it('unsticks session back to iterating when a refine render fails', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 304, session_id: 's-304', iteration: 2, template: 'lower-third',
        parent_render_id: 204,
        human_feedback: 'thing',
        spec_snapshot_json: { template: 'lower-third', mainText: 'X', subText: 'Y', aspectRatio: '16:9', duration: 5, tone: 'neutral' },
      })
      .mockResolvedValueOnce({ final_html_text: null })  // triggers the throw
      .mockResolvedValue(null)

    const origTransaction = db.transaction
    db.transaction = async (fn) => fn({ prepare: (...args) => db.prepare(...args) })
    const prepareSpy = vi.spyOn(db, 'prepare')

    try {
      const { drainOnce } = await import('../render-worker.js')
      const result = await drainOnce()

      expect(result.processed).toBe(0)
      expect(result.errors).toHaveLength(1)

      const sqls = prepareSpy.mock.calls.map((c) => c[0])
      const failedMark = sqls.find(
        (s) => /UPDATE graphics_renders/.test(s) && /status\s*=\s*'failed'/.test(s)
      )
      // The SQL now passes the next status as a parameter, so look for the
      // shape instead of a quoted literal. Value-level assertion (iterating
      // vs briefing) lives in the dedicated tests in the lint-failure block.
      const unstickSession = sqls.find(
        (s) => /UPDATE graphics_sessions/.test(s) && /SET status/.test(s)
      )
      expect(failedMark).toBeDefined()
      expect(unstickSession).toBeDefined()
    } finally {
      prepareSpy.mockRestore()
      db.transaction = origTransaction
    }
  })
})

describe('renderWorker.drainOnce — final_html_text persistence', () => {
  it('writes the final HTML into the completion UPDATE', async () => {
    const db = (await import('../../../db.js')).default
    const sharedGet = db.prepare().get
    sharedGet.mockReset()
    sharedGet
      .mockResolvedValueOnce({
        id: 200, session_id: 's-200', iteration: 1, template: 'lower-third',
        spec_snapshot_json: {
          template: 'lower-third', mainText: 'Hi', subText: 'Sub',
          aspectRatio: '16:9', duration: 5, tone: 'neutral',
        },
      })
      .mockResolvedValue(null)

    const { specToHtml, refineHtml } = await import('../html-generator.js')
    const { runLint } = await import('../lint-runner.js')
    const { renderHtml } = await import('../render-runner.js')
    const { runCritic } = await import('../critic/critic-runner.js')
    const { uploadRender } = await import('../uploader.js')

    runLint.mockReset()
    runLint.mockResolvedValue({ errorCount: 0, warningCount: 0, infoCount: 0, findings: [] })
    specToHtml.mockClear()
    specToHtml.mockResolvedValue({
      html: '<!doctype html><html><body><div id="main" data-composition-id="main" data-duration="5">FINAL_HTML_MARKER</div></body></html>',
      cost: 1, tokens: { in: 100, out: 100 },
    })
    refineHtml.mockClear()
    renderHtml.mockClear()
    renderHtml.mockResolvedValue({ outputPath: '/tmp/x.mp4', durationMs: 1000 })
    uploadRender.mockClear()
    uploadRender.mockResolvedValue({ url: 'http://supa/x.mp4' })
    runCritic.mockReset()
    runCritic.mockResolvedValue({
      score: 0.9, criteria: {}, feedback: 'good',
      retry_recommended: false, frameUrls: [], tokens: { in: 0, out: 0 },
    })

    // Spy on db.prepare, then re-wire db.transaction so the tx argument the
    // worker receives also goes through the spy (the default mock closes over
    // prepareMock directly, bypassing the spy wrapper).
    const prepareSpy = vi.spyOn(db, 'prepare')
    const origTransaction = db.transaction
    db.transaction = vi.fn(async (fn) => fn({ prepare: (...args) => db.prepare(...args) }))

    const { drainOnce } = await import('../render-worker.js')
    const result = await drainOnce()

    expect(result.processed).toBe(1)
    const sqls = prepareSpy.mock.calls.map((c) => c[0])
    const completionUpdate = sqls.find(
      (s) => /UPDATE graphics_renders/.test(s) && /status\s*=\s*'complete'/.test(s)
    )
    expect(completionUpdate).toBeDefined()
    expect(completionUpdate).toMatch(/final_html_text\s*=\s*\?/)
    prepareSpy.mockRestore()
    db.transaction = origTransaction
  })
})
