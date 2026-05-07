// server/services/graphics/__tests__/critic-loop-integration.test.js
//
// End-to-end smoke for the critic-loop retry path.
// LLMs, render-runner, uploader, frame-extractor, evaluator are mocked;
// database is REAL. Skipped when DATABASE_URL is unset.

import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../../../lib/llm/gemini.js', () => ({
  callGemini: vi
    .fn()
    .mockResolvedValueOnce({
      text: 'What aspect ratio?\n[SPEC]{"template":"lower-third","tone":"neutral"}',
      toolUses: [], tokens: { in: 200, out: 30 }, stop: 'STOP',
    })
    .mockResolvedValueOnce({
      text: 'Got it. Looks good.\n[SPEC]{"aspectRatio":"16:9","duration":5,"mainText":"Hello","subText":"World"}',
      toolUses: [], tokens: { in: 250, out: 40 }, stop: 'STOP',
    }),
}))

const RETRY_HTML = '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">retry</div></body></html>'

vi.mock('../../../lib/llm/anthropic.js', () => ({
  callAnthropic: vi.fn().mockResolvedValue({
    text: RETRY_HTML,
    toolUses: [], tokens: { in: 600, out: 90 }, stop: 'end_turn',
  }),
}))

vi.mock('../html-generator.js', () => ({
  specToHtml: vi.fn().mockResolvedValue({
    html: '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080"></div></body></html>',
    cost: 5,
    tokens: { in: 600, out: 400 },
  }),
  CREATE_HTML_SYSTEM_PROMPT: 'mock-create-html-system-prompt',
}))

vi.mock('../render-runner.js', () => ({
  renderHtml: vi.fn().mockResolvedValue({
    outputPath: '/tmp/integration-x.mp4',
    bytes: 1234,
    durationMs: 5000,
    workDir: '/tmp/integration-x',
  }),
}))

vi.mock('../uploader.js', () => ({
  uploadRender: vi.fn().mockResolvedValue({ url: 'https://example.test/x.mp4' }),
  uploadFrames: vi.fn().mockResolvedValue([
    'https://example.test/f0.png',
    'https://example.test/f1.png',
    'https://example.test/f2.png',
    'https://example.test/f3.png',
  ]),
}))

vi.mock('../critic/frame-extractor.js', () => ({
  extractFrames: vi.fn().mockResolvedValue([
    '/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png', '/tmp/f3.png',
  ]),
}))

vi.mock('../critic/evaluator.js', () => ({
  evaluateFrames: vi
    .fn()
    .mockResolvedValueOnce({
      score: 0.4, criteria: { fidelity: 0.4 }, feedback: 'too small',
      retry_recommended: true, tokens: { in: 0, out: 0 },
    })
    .mockResolvedValueOnce({
      score: 0.5, criteria: { fidelity: 0.5 }, feedback: 'still small',
      retry_recommended: true, tokens: { in: 0, out: 0 },
    })
    .mockResolvedValueOnce({
      score: 0.85, criteria: { fidelity: 0.85 }, feedback: 'good',
      retry_recommended: false, tokens: { in: 0, out: 0 },
    }),
}))

vi.mock('../../../auth.js', () => ({
  requireAuth: (req, res, next) => req.auth ? next() : res.status(401).json({ error: 'unauthorized' }),
  isAdmin: () => true,
  verifyTokenString: vi.fn(async () => null),
}))

const skip = !process.env.DATABASE_URL
const d = skip ? describe.skip : describe

let router
let drainOnce
let dbDefault

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test'
  router = (await import('../../../routes/graphics.js')).default
  drainOnce = (await import('../render-worker.js')).drainOnce
  dbDefault = (await import('../../../db.js')).default
})

// ── Helpers ──────────────────────────────────────────────────────────────
function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
  }
}

async function runChain(handlers, req, res) {
  for (const h of handlers) {
    if (res.body !== null) return
    let called = false
    await new Promise((resolve, reject) => {
      const next = (err) => { called = true; if (err) reject(err); else resolve() }
      const ret = h(req, res, next)
      if (ret && typeof ret.then === 'function') {
        ret.then(() => { if (!called) resolve() }, reject)
      } else if (!called) resolve()
    })
  }
}

function handlersFor(method, pathPattern) {
  const layer = router.stack.find(
    (l) => l.route?.path === pathPattern && l.route.methods[method]
  )
  if (!layer) throw new Error(`no ${method} route for ${pathPattern}`)
  const middleware = router.stack.filter((l) => !l.route && l.handle).map((l) => l.handle)
  return [...middleware, ...layer.route.stack.map((s) => s.handle)]
}

function adminReq(method, _pathPattern, paramsAndBody = {}) {
  const { body = {}, params = {} } = paramsAndBody
  return {
    auth: { userId: 'critic-loop-test-user', email: 'silvestras.stonk@gmail.com' },
    body, params,
  }
}

// ── Test ─────────────────────────────────────────────────────────────────
d('motion graphics critic loop', () => {
  it('renders → fails critic → retries 2x → ships best', async () => {
    // 1. Create session
    const createReq = adminReq('post', '/sessions', { body: { title: 'CriticLoop' } })
    const createRes = makeRes()
    await runChain(handlersFor('post', '/sessions'), createReq, createRes)
    expect(createRes.statusCode).toBe(201)
    const sessionId = createRes.body.id

    // 2. Turn 1: incomplete spec → no render
    const t1Req = adminReq('post', '/sessions/:id/messages', {
      params: { id: String(sessionId) },
      body: { message: 'I want a lower-third for an interview clip' },
    })
    const t1Res = makeRes()
    await runChain(handlersFor('post', '/sessions/:id/messages'), t1Req, t1Res)
    expect(t1Res.statusCode).toBe(200)
    expect(t1Res.body.renderId).toBeNull()

    // 3. Turn 2: completes spec → render row enqueued
    const t2Req = adminReq('post', '/sessions/:id/messages', {
      params: { id: String(sessionId) },
      body: { message: '16:9, 5 seconds, "Hello" / "World"' },
    })
    const t2Res = makeRes()
    await runChain(handlersFor('post', '/sessions/:id/messages'), t2Req, t2Res)
    expect(t2Res.statusCode).toBe(200)
    expect(t2Res.body.renderId).not.toBeNull()
    const renderId = t2Res.body.renderId

    // 4. Worker drain — runs critic loop with chained scores 0.4, 0.5, 0.85
    const { processed, errors } = await drainOnce()
    expect(processed).toBe(1)
    expect(errors).toHaveLength(0)

    // 5. GET /sessions/:id confirms iteration_count + final_score
    const detailReq = adminReq('get', '/sessions/:id', { params: { id: String(sessionId) } })
    const detailRes = makeRes()
    await runChain(handlersFor('get', '/sessions/:id'), detailReq, detailRes)
    expect(detailRes.statusCode).toBe(200)
    expect(detailRes.body.renders).toHaveLength(1)
    const final = detailRes.body.renders[0]
    expect(final.status).toBe('complete')
    expect(final.iteration_count).toBe(3)
    // final_score is NUMERIC — pg returns it as a string by default
    expect(parseFloat(final.final_score)).toBeCloseTo(0.85, 2)

    // 6. Direct DB query: graphics_render_iterations has 3 rows for this render
    const iters = await dbDefault.pool.query(
      `SELECT iteration_index, critic_score FROM graphics_render_iterations WHERE render_id = $1 ORDER BY iteration_index ASC`,
      [renderId]
    )
    expect(iters.rows).toHaveLength(3)
    expect(parseFloat(iters.rows[0].critic_score)).toBeCloseTo(0.4, 2)
    expect(parseFloat(iters.rows[1].critic_score)).toBeCloseTo(0.5, 2)
    expect(parseFloat(iters.rows[2].critic_score)).toBeCloseTo(0.85, 2)
  })
})
