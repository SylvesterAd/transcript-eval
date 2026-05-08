import { describe, it, expect, vi } from 'vitest'

vi.mock('../../services/graphics/events/emitter.js', () => {
  const subs = new Map()
  return {
    subscribe: vi.fn((id, cb) => {
      if (!subs.has(id)) subs.set(id, new Set())
      subs.get(id).add(cb)
      return () => subs.get(id)?.delete(cb)
    }),
    emit: vi.fn((e) => {
      subs.get(e.sessionId)?.forEach((cb) => cb(e))
    }),
  }
})
vi.mock('../../auth.js', () => ({
  requireAuth: (req, res, next) => req.auth ? next() : res.status(401).json({ error: 'no auth' }),
  isAdmin: (req) => req.auth?.isAdminFlag === true,
  verifyTokenString: vi.fn(async () => null),
}))
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      get: vi.fn().mockResolvedValue({ id: 7 }),
      run: vi.fn(),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

const routerModule = await import('../graphics-events.js')
const router = routerModule.default

function makeRes() {
  const headers = {}
  const writes = []
  return {
    statusCode: 200,
    body: null,
    headers,
    writes,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    writeHead(code, h) { this.statusCode = code; Object.assign(headers, h); return this },
    write(chunk) { writes.push(chunk); return true },
    flushHeaders() {},
    end() { this.ended = true },
    on() {},
  }
}

function handlersFor(method, pathPattern) {
  const layer = router.stack.find((l) => l.route?.path === pathPattern && l.route.methods[method])
  if (!layer) throw new Error(`no ${method} route for ${pathPattern}`)
  const middleware = router.stack.filter((l) => !l.route && l.handle).map((l) => l.handle)
  return [...middleware, ...layer.route.stack.map((s) => s.handle)]
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
      } else if (!called) {
        resolve()
      }
    })
  }
}

describe('GET /sessions/:id/events', () => {
  it('admin (header auth): opens SSE stream + receives events', async () => {
    const handlers = handlersFor('get', '/sessions/:id/events')
    const req = {
      auth: { userId: 'u1', email: 'a@b', isAdminFlag: true },
      params: { id: '7' },
      query: {},
      on: vi.fn(),
    }
    const res = makeRes()
    await runChain(handlers, req, res)

    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('text/event-stream')
    // Initial open event
    expect(res.writes.some((w) => w.includes('event: open'))).toBe(true)

    // Simulate a subsequent emit
    const { emit } = await import('../../services/graphics/events/emitter.js')
    emit({ sessionId: 7, step: 'render_queued', label: 'Queued' })
    expect(res.writes.some((w) => w.includes('render_queued'))).toBe(true)
  })

  it('no auth: 401', async () => {
    const handlers = handlersFor('get', '/sessions/:id/events')
    const req = { params: { id: '7' }, query: {}, on: vi.fn() }
    const res = makeRes()
    await runChain(handlers, req, res)
    expect(res.statusCode).toBe(401)
  })

  it('non-admin: 403', async () => {
    const handlers = handlersFor('get', '/sessions/:id/events')
    const req = {
      auth: { userId: 'u2', email: 'r@b', isAdminFlag: false },
      params: { id: '7' },
      query: {},
      on: vi.fn(),
    }
    const res = makeRes()
    await runChain(handlers, req, res)
    expect(res.statusCode).toBe(403)
  })
})
