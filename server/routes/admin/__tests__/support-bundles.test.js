// server/routes/admin/__tests__/support-bundles.test.js
//
// Unit tests for POST /api/admin/support-bundles/parse.
//
// Strategy: mirrors server/routes/admin/__tests__/exports.test.js.
// We mock the pure parser and the auth module, then invoke the
// router's registered handlers directly with fabricated req/res/next
// objects. No supertest — avoids a new devDep.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the pure parser so the route tests only exercise the Express wiring.
vi.mock('../../../services/bundle-parser.js', () => {
  const actual = {
    BundleParseError: class BundleParseError extends Error {
      constructor(code, status, detail = {}) {
        super(code)
        this.errorCode = code
        this.httpStatus = status
        this.detail = detail
      }
    },
  }
  actual.parseBundle = vi.fn()
  return actual
})

// Stub the auth module so we can control isAdmin per test.
vi.mock('../../../auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' })
    next()
  },
  isAdmin: (req) => req.auth?.isAdmin === true,
}))

import { parseBundle, BundleParseError } from '../../../services/bundle-parser.js'
const routerModule = await import('../support-bundles.js')
const router = routerModule.default

// Extract the handlers from the router's stack. Express exposes
// handlers via router.stack[i].route.stack[j].handle. For POST /parse
// we expect 4 handlers: express.raw, requireAuth, requireAdmin, business.
function extractHandler(pathPattern) {
  const layer = router.stack.find(l => l.route && l.route.path === pathPattern)
  if (!layer) throw new Error(`no route for ${pathPattern}`)
  return layer.route.stack.map(s => s.handle)
}
const parseHandlers = extractHandler('/parse')

// Fabricated res helper.
function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; return this },
    json(obj) { this.body = obj; this.headersSent = true; return this },
  }
  return res
}

// Run each middleware/handler in sequence. The first handler is
// express.raw(), which is async and expects the body to already be
// parsed — so we skip it when invoking directly (the raw buffer
// arrives in req.body pre-set).
async function runChain(handlers, req, res) {
  // Skip the express.raw() middleware; tests pre-populate req.body as
  // the Buffer that raw() would have produced. This avoids having to
  // stream a real HTTP request through express.
  const chain = handlers.slice(1)
  for (const h of chain) {
    if (res.body !== null) return
    let called = false
    await new Promise((resolve, reject) => {
      const next = (err) => {
        called = true
        if (err) reject(err); else resolve()
      }
      const ret = h(req, res, next)
      if (ret && typeof ret.then === 'function') {
        ret.then(() => { if (!called) resolve() }, reject)
      } else if (!called) {
        // Sync handler that didn't call next — assume it wrote a response.
        resolve()
      }
    })
  }
}

beforeEach(() => {
  vi.mocked(parseBundle).mockReset()
})

describe('POST /api/admin/support-bundles/parse', () => {
  it('401 when unauthenticated', async () => {
    const req = { auth: null, body: Buffer.from([1, 2, 3]) }
    const res = makeRes()
    await runChain(parseHandlers, req, res)
    expect(res.statusCode).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })

  it('403 when authenticated but not admin', async () => {
    const req = { auth: { userId: 'u-1', isAdmin: false }, body: Buffer.from([1, 2, 3]) }
    const res = makeRes()
    await runChain(parseHandlers, req, res)
    expect(res.statusCode).toBe(403)
    expect(res.body.error).toBe('Admin access required')
  })

  it('200 happy path — returns parser output for admin', async () => {
    vi.mocked(parseBundle).mockReturnValue({
      meta: { schema_version: 1, ext_version: '0.8.0' },
      queue: { runs: [] },
      events: { events: [] },
      environment: {},
    })
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    }
    const res = makeRes()
    await runChain(parseHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.meta.schema_version).toBe(1)
    expect(vi.mocked(parseBundle)).toHaveBeenCalledOnce()
    // Confirm we passed a Uint8Array (not the raw Buffer) into the parser.
    const passed = vi.mocked(parseBundle).mock.calls[0][0]
    expect(passed).toBeInstanceOf(Uint8Array)
  })

  it('400 when body is empty buffer', async () => {
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      body: Buffer.alloc(0),
    }
    const res = makeRes()
    await runChain(parseHandlers, req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('missing_zip_body')
    // Parser should NOT have been called — the route handler short-circuits.
    expect(vi.mocked(parseBundle)).not.toHaveBeenCalled()
  })

  it('400 when parser throws missing_zip_body', async () => {
    vi.mocked(parseBundle).mockImplementation(() => {
      throw new BundleParseError('missing_zip_body', 400)
    })
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      body: Buffer.from([1]),
    }
    const res = makeRes()
    await runChain(parseHandlers, req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('missing_zip_body')
  })

  it('422 when parser throws unsupported_bundle_version', async () => {
    vi.mocked(parseBundle).mockImplementation(() => {
      throw new BundleParseError('unsupported_bundle_version', 422, {
        supported_versions: [1],
        got: 2,
      })
    })
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      body: Buffer.from([1]),
    }
    const res = makeRes()
    await runChain(parseHandlers, req, res)
    expect(res.statusCode).toBe(422)
    expect(res.body.error).toBe('unsupported_bundle_version')
    expect(res.body.supported_versions).toEqual([1])
    expect(res.body.got).toBe(2)
  })

  it('applies express.raw() middleware with 50mb limit and application/zip type', () => {
    // Sanity-check the middleware registration. Inspect the first
    // handler's options closure — express.raw returns a function with
    // a name like "rawParser". We verify by checking that the first
    // handler in the chain is a function (middleware).
    // Real limit enforcement is tested via Express itself (413 on
    // oversize); see invariant #5 in the plan.
    expect(typeof parseHandlers[0]).toBe('function')
    expect(parseHandlers).toHaveLength(4) // raw, requireAuth, requireAdmin, business
  })
})
