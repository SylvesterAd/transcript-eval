// server/routes/__tests__/graphics.test.js
//
// Routes tested via fabricated req/res (no supertest — matches existing
// pattern in routes/admin/__tests__/exports.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';

let nextSession = { id: 7, user_id: 'user-1', user_email: 'admin@test', title: 'New graphic', spec_json: {}, status: 'briefing', created_at: '2026-05-07T00:00:00Z' };
let nextRow = null;
let nextRows = [];

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async run() { return { lastInsertRowid: 1, changes: 1 }; },
        async get(...params) {
          if (/INSERT INTO graphics_sessions/i.test(sql)) return nextSession;
          return nextRow;
        },
        async all() { return nextRows; },
      };
    },
  },
}));

vi.mock('../../auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
    next();
  },
  isAdmin: (req) => req.auth?.isAdminFlag === true,
}));

vi.mock('../../services/graphics/orchestrator.js', () => ({
  runChatTurn: vi.fn().mockResolvedValue({
    assistantText: 'Got it.',
    specUpdate: { aspectRatio: '16:9' },
    newSpec: { aspectRatio: '16:9' },
    renderId: null,
    cost: 1,
  }),
}));

const routerModule = await import('../graphics.js');
const router = routerModule.default;

function extractHandlers(pathPattern, method = 'post') {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === pathPattern && l.route.methods[method]
  );
  if (!layer) throw new Error(`no ${method} route for ${pathPattern}`);
  // Compose router-level middleware + route-level handlers
  const routerMiddleware = router.stack
    .filter((l) => !l.route && l.handle)
    .map((l) => l.handle);
  return [...routerMiddleware, ...layer.route.stack.map((s) => s.handle)];
}

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

describe('POST /sessions', () => {
  beforeEach(() => {
    nextSession = { id: 7, user_id: 'user-1', user_email: 'admin@test', title: 'New graphic', spec_json: {}, status: 'briefing', created_at: '2026-05-07T00:00:00Z' };
  });

  it('admin: 201 + new session', async () => {
    const handlers = extractHandlers('/sessions', 'post');
    const req = {
      auth: { userId: 'user-1', email: 'admin@test', isAdminFlag: true },
      body: { title: 'Test' },
    };
    const res = makeRes();
    await runChain(handlers, req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBe(7);
  });

  it('non-admin: 403', async () => {
    const handlers = extractHandlers('/sessions', 'post');
    const req = {
      auth: { userId: 'user-2', email: 'rando@test', isAdminFlag: false },
      body: { title: 'Test' },
    };
    const res = makeRes();
    await runChain(handlers, req, res);
    expect(res.statusCode).toBe(403);
  });

  it('no auth: 401', async () => {
    const handlers = extractHandlers('/sessions', 'post');
    const req = { body: { title: 'Test' } }; // no req.auth
    const res = makeRes();
    await runChain(handlers, req, res);
    expect(res.statusCode).toBe(401);
  });
});
