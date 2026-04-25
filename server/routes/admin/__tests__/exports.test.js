// server/routes/admin/__tests__/exports.test.js
//
// Unit tests for GET /api/admin/exports and GET /:id/events.
//
// Strategy: same as server/services/__tests__/exports.test.js —
// vi.mock('../../../db.js') with a scripted in-memory fake.
// The handlers are called directly with fabricated req/res/next
// objects (no supertest — avoids a new devDep, and the middleware
// chain is short enough to exercise manually).
//
// Auth model tests: we fabricate `req.auth` per test to represent
// (a) missing auth, (b) non-admin auth, (c) admin auth.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake db state.
let listRows = []
let listCount = 0
let eventsRows = []
let exportRow = null
// Captured SQL for assertions about WHERE clauses / ORDER BY.
const capturedSql = []
const capturedParams = []

vi.mock('../../../db.js', () => ({
  default: {
    prepare(sql) {
      capturedSql.push(sql)
      return {
        async all(...params) {
          capturedParams.push(params)
          if (/FROM exports\b/i.test(sql) && /LIMIT \? OFFSET \?/i.test(sql)) {
            return listRows
          }
          if (/FROM export_events/i.test(sql) && /WHERE export_id = \?/i.test(sql)) {
            return eventsRows
          }
          throw new Error(`unexpected .all SQL: ${sql}`)
        },
        async get(...params) {
          capturedParams.push(params)
          if (/SELECT COUNT\(\*\) AS total FROM exports/i.test(sql)) {
            return { total: listCount }
          }
          if (/FROM exports WHERE id = \?/i.test(sql)) {
            return exportRow
          }
          throw new Error(`unexpected .get SQL: ${sql}`)
        },
      }
    },
  },
}))

// Stub the auth module so we can control isAdmin per test.
vi.mock('../../../auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' })
    next()
  },
  isAdmin: (req) => req.auth?.isAdmin === true,
}))

const routerModule = await import('../exports.js')
const router = routerModule.default

// Extract the handlers from the router's stack. Express exposes
// handlers via router.stack[i].route.stack[j].handle. Order: the
// list route is registered first, then the events route.
function extractHandler(pathPattern) {
  const layer = router.stack.find(l => l.route && l.route.path === pathPattern)
  if (!layer) throw new Error(`no route for ${pathPattern}`)
  return layer.route.stack.map(s => s.handle)
}
const listHandlers = extractHandler('/')
const eventsHandlers = extractHandler('/:id/events')

// Fabricated res helper.
function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(obj) { this.body = obj; return this },
  }
  return res
}

// Run each middleware/handler in sequence. If one of them writes a
// response (res.body is set) OR calls next with an error, stop.
// The final handler in the chain is async and will resolve on its own.
async function runChain(handlers, req, res) {
  for (const h of handlers) {
    if (res.body !== null) return                     // prior handler wrote a response; stop
    let called = false
    const nextPromise = new Promise((resolve, reject) => {
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
    await nextPromise
  }
}

beforeEach(() => {
  listRows = []
  listCount = 0
  eventsRows = []
  exportRow = null
  capturedSql.length = 0
  capturedParams.length = 0
})

describe('GET /api/admin/exports (list)', () => {
  it('401 when unauthenticated', async () => {
    const req = { auth: null, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })

  it('403 when authed but non-admin', async () => {
    const req = { auth: { userId: 'u-1', isAdmin: false }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(403)
  })

  it('200 for admin with default pagination', async () => {
    listRows = [
      { id: 'exp_A', user_id: 'u-1', plan_pipeline_id: 'pp-1', variant_labels: '["A"]',
        status: 'complete', folder_path: '~/a', created_at: '2026-04-24', completed_at: null,
        failed_count: 0, downloaded_count: 3 },
    ]
    listCount = 1
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      exports: listRows,
      total: 1,
      limit: 50,
      offset: 0,
    })
  })

  it('applies failures_only filter via status IN (failed, partial)', async () => {
    listCount = 0
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: { failures_only: 'true' },
      params: {},
    }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(capturedSql.join('\n')).toContain("status IN ('failed','partial')")
  })

  it('applies user_id filter as prepared-statement param', async () => {
    listCount = 0
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: { user_id: 'u-target' },
      params: {},
    }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(capturedSql.join('\n')).toMatch(/user_id = \?/)
    // First all() call is the list; its first param should be u-target
    // followed by limit and offset.
    expect(capturedParams[0]).toEqual(['u-target', 50, 0])
  })

  it('applies since + until as prepared-statement params', async () => {
    listCount = 0
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: { since: '2026-04-17T00:00:00Z', until: '2026-04-24T00:00:00Z' },
      params: {},
    }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(capturedSql.join('\n')).toMatch(/created_at >= \?/)
    expect(capturedSql.join('\n')).toMatch(/created_at <= \?/)
    expect(capturedParams[0]).toEqual([
      '2026-04-17T00:00:00Z', '2026-04-24T00:00:00Z', 50, 0,
    ])
  })

  it('caps limit at 200', async () => {
    listCount = 0
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: { limit: '9999' },
      params: {},
    }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.body.limit).toBe(200)
  })
})

describe('GET /api/admin/exports/:id/events (timeline)', () => {
  it('404 when export not found', async () => {
    exportRow = null
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { id: 'exp_MISSING' },
    }
    const res = makeRes()
    await runChain(eventsHandlers, req, res)
    expect(res.statusCode).toBe(404)
  })

  it('200 with events + aggregates when export exists', async () => {
    exportRow = {
      id: 'exp_OK', user_id: 'u-1', plan_pipeline_id: 'pp-1',
      variant_labels: '["A"]', status: 'complete',
      manifest_json: '{}', result_json: null, xml_paths: null,
      folder_path: '~/d', created_at: '2026-04-24', completed_at: null,
    }
    eventsRows = [
      { id: 1, event: 'export_started', item_id: null, source: null, phase: null,
        error_code: null, http_status: null, retry_count: 0, meta_json: '{"n":2}',
        t: 1000, received_at: 1001 },
      { id: 2, event: 'item_downloaded', item_id: 'X', source: 'envato', phase: 'download',
        error_code: null, http_status: 200, retry_count: 0, meta_json: null,
        t: 2000, received_at: 2001 },
      { id: 3, event: 'item_failed', item_id: 'Y', source: 'pexels', phase: 'download',
        error_code: 'pexels_429', http_status: 429, retry_count: 2, meta_json: null,
        t: 3000, received_at: 3001 },
    ]
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { id: 'exp_OK' },
    }
    const res = makeRes()
    await runChain(eventsHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.export.id).toBe('exp_OK')
    expect(res.body.events).toHaveLength(3)
    // Meta parsed
    expect(res.body.events[0].meta).toEqual({ n: 2 })
    // Aggregates
    expect(res.body.aggregates.fail_count).toBe(1)
    expect(res.body.aggregates.success_count).toBe(1)
    expect(res.body.aggregates.by_source).toEqual({
      envato: { failed: 0, succeeded: 1 },
      pexels: { failed: 1, succeeded: 0 },
    })
    expect(res.body.aggregates.by_error_code).toEqual({ pexels_429: 1 })
  })

  it('orders events by t ASC to hit idx_export_events_export', async () => {
    exportRow = {
      id: 'exp_OK', user_id: 'u-1', plan_pipeline_id: 'pp-1',
      variant_labels: '["A"]', status: 'complete',
      manifest_json: '{}', result_json: null, xml_paths: null,
      folder_path: null, created_at: '2026-04-24', completed_at: null,
    }
    eventsRows = []
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { id: 'exp_OK' },
    }
    const res = makeRes()
    await runChain(eventsHandlers, req, res)
    expect(capturedSql.join('\n')).toMatch(/ORDER BY t ASC/)
  })

  it('403 when non-admin', async () => {
    const req = {
      auth: { userId: 'u-1', isAdmin: false },
      query: {}, params: { id: 'exp_OK' },
    }
    const res = makeRes()
    await runChain(eventsHandlers, req, res)
    expect(res.statusCode).toBe(403)
  })
})
