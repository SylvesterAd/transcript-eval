// server/services/graphics/__tests__/integration-flow.test.js
//
// End-to-end smoke for the brief → render flow.
// LLMs, render-runner, and uploader are mocked; database is REAL.
// Skipped when DATABASE_URL is unset (so CI without a DB passes cleanly).

import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../../lib/llm/gemini.js', () => ({
  callGemini: vi
    .fn()
    .mockResolvedValueOnce({
      text:
        'What aspect ratio do you want?\n[SPEC]{"template":"lower-third","tone":"neutral"}',
      toolUses: [],
      tokens: { in: 200, out: 30 },
      stop: 'STOP',
    })
    .mockResolvedValueOnce({
      text:
        'Got it. Looks good. Rendering now.\n[SPEC]{"aspectRatio":"16:9","duration":5,"mainText":"Hello","subText":"World"}',
      toolUses: [],
      tokens: { in: 250, out: 40 },
      stop: 'STOP',
    }),
}));

vi.mock('../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn().mockResolvedValue({
    text:
      '{"width":1920,"height":1080,"duration":5,"mainText":"Hello","subText":"World","accent":"#9ca3af","barBottom":80,"barLeft":80,"barHeight":120,"barMaxWidth":1056,"mainSize":48,"subSize":18}',
    toolUses: [],
    tokens: { in: 600, out: 90 },
    stop: 'end_turn',
  }),
}));

vi.mock('../render-runner.js', () => ({
  renderTemplate: vi.fn().mockResolvedValue({
    outputPath: '/tmp/integration-x.mp4',
    bytes: 1234,
    durationMs: 5000,
    workDir: '/tmp/integration-x',
  }),
}));

vi.mock('../uploader.js', () => ({
  uploadRender: vi.fn().mockResolvedValue({ url: 'https://example.test/x.mp4' }),
}));

vi.mock('../../../auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'unauthorized' });
    next();
  },
  isAdmin: () => true,
}));

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

let router;
let drainOnce;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test';
  router = (await import('../../../routes/graphics.js')).default;
  drainOnce = (await import('../render-worker.js')).drainOnce;
});

// ── Helpers ──────────────────────────────────────────────────────────
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

async function runChain(handlers, req, res) {
  for (const h of handlers) {
    if (res.body !== null) return;
    let called = false;
    await new Promise((resolve, reject) => {
      const next = (err) => { called = true; if (err) reject(err); else resolve(); };
      const ret = h(req, res, next);
      if (ret && typeof ret.then === 'function') {
        ret.then(() => { if (!called) resolve(); }, reject);
      } else if (!called) {
        resolve();
      }
    });
  }
}

function handlersFor(method, pathPattern) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === pathPattern && l.route.methods[method]
  );
  if (!layer) throw new Error(`no ${method} route for ${pathPattern}`);
  const middleware = router.stack.filter((l) => !l.route && l.handle).map((l) => l.handle);
  return [...middleware, ...layer.route.stack.map((s) => s.handle)];
}

function adminReq(method, pathPattern, paramsAndBody = {}) {
  const { body = {}, params = {} } = paramsAndBody;
  return {
    auth: { userId: 'integration-user-1', email: 'silvestras.stonk@gmail.com' },
    body,
    params,
  };
}

// ── Test ─────────────────────────────────────────────────────────────
d('motion graphics MVP flow', () => {
  it('create session → chat 2 turns → render → drain → complete', async () => {
    // 1. Create session
    const createReq = adminReq('post', '/sessions', { body: { title: 'IntegrationFlow' } });
    const createRes = makeRes();
    await runChain(handlersFor('post', '/sessions'), createReq, createRes);
    expect(createRes.statusCode).toBe(201);
    const sessionId = createRes.body.id;

    // 2. Turn 1: incomplete spec → no render
    const t1Req = adminReq('post', '/sessions/:id/messages', {
      params: { id: String(sessionId) },
      body: { message: 'I want a lower-third for an interview clip' },
    });
    const t1Res = makeRes();
    await runChain(handlersFor('post', '/sessions/:id/messages'), t1Req, t1Res);
    expect(t1Res.statusCode).toBe(200);
    expect(t1Res.body.assistantText).toMatch(/aspect/i);
    expect(t1Res.body.renderId).toBeNull();

    // 3. Turn 2: completes spec → render row enqueued
    const t2Req = adminReq('post', '/sessions/:id/messages', {
      params: { id: String(sessionId) },
      body: { message: '16:9, 5 seconds, "Hello" / "World"' },
    });
    const t2Res = makeRes();
    await runChain(handlersFor('post', '/sessions/:id/messages'), t2Req, t2Res);
    expect(t2Res.statusCode).toBe(200);
    expect(t2Res.body.renderId).not.toBeNull();

    // 4. Worker drain (mocked render+upload)
    const { processed, errors } = await drainOnce();
    expect(processed).toBe(1);
    expect(errors).toHaveLength(0);

    // 5. GET /sessions/:id confirms complete
    const detailReq = adminReq('get', '/sessions/:id', { params: { id: String(sessionId) } });
    const detailRes = makeRes();
    await runChain(handlersFor('get', '/sessions/:id'), detailReq, detailRes);
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.body.renders).toHaveLength(1);
    expect(detailRes.body.renders[0].status).toBe('complete');
    expect(detailRes.body.renders[0].output_url).toMatch(/^https:/);
  });
});
