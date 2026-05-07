// server/routes/admin/__tests__/users.test.js
//
// Unit tests for GET /api/admin/users and GET /:userId. Mirrors the
// approach in exports.test.js: vi.mock the db, vi.mock the supabase
// admin client, vi.mock auth — drive handlers via a synthetic chain.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── db mock ───────────────────────────────────────────────────────
let projectCountRows = []
let projectsForUser = []
const capturedSql = []
const capturedParams = []

vi.mock('../../../db.js', () => ({
  default: {
    prepare(sql) {
      capturedSql.push(sql)
      return {
        async all(...params) {
          capturedParams.push(params)
          if (/COUNT\(\*\) AS project_count/i.test(sql)) {
            return projectCountRows
          }
          if (/FROM video_groups/i.test(sql)) {
            return projectsForUser
          }
          throw new Error(`unexpected .all SQL: ${sql}`)
        },
      }
    },
  },
}))

// ── auth mock ─────────────────────────────────────────────────────
vi.mock('../../../auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' })
    next()
  },
  isAdmin: (req) => req.auth?.isAdmin === true,
}))

// ── supabase admin mock ───────────────────────────────────────────
let supabaseConfigured = true
let listUsersResponse = { data: { users: [] }, error: null }
let getUserByIdResponse = { data: { user: null }, error: null }
let generateLinkResponse = { data: { properties: { action_link: null } }, error: null }
const generateLinkCalls = []

vi.mock('../../../services/supabase-admin.js', () => ({
  hasSupabaseAdminConfig: () => supabaseConfigured,
  getSupabaseAdmin: () => ({
    auth: {
      admin: {
        listUsers: async () => listUsersResponse,
        getUserById: async () => getUserByIdResponse,
        generateLink: async (args) => {
          generateLinkCalls.push(args)
          return generateLinkResponse
        },
      },
    },
  }),
}))

const routerModule = await import('../users.js')
const router = routerModule.default

function extractHandler(pathPattern) {
  const layer = router.stack.find(l => l.route && l.route.path === pathPattern)
  if (!layer) throw new Error(`no route for ${pathPattern}`)
  return layer.route.stack.map(s => s.handle)
}
const listHandlers = extractHandler('/')
const detailHandlers = extractHandler('/:userId')
const impersonateHandlers = extractHandler('/:userId/impersonate')

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(obj) { this.body = obj; return this },
  }
}

async function runChain(handlers, req, res) {
  for (const h of handlers) {
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
        resolve()
      }
    })
  }
}

beforeEach(() => {
  projectCountRows = []
  projectsForUser = []
  capturedSql.length = 0
  capturedParams.length = 0
  supabaseConfigured = true
  listUsersResponse = { data: { users: [] }, error: null }
  getUserByIdResponse = { data: { user: null }, error: null }
  generateLinkResponse = { data: { properties: { action_link: null } }, error: null }
  generateLinkCalls.length = 0
})

describe('GET /api/admin/users (list)', () => {
  it('401 when unauthenticated', async () => {
    const req = { auth: null, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(401)
  })

  it('403 when authed but non-admin', async () => {
    const req = { auth: { userId: 'u-1', isAdmin: false }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(403)
  })

  it('503 when SUPABASE_SERVICE_ROLE_KEY not configured', async () => {
    supabaseConfigured = false
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(503)
    expect(res.body.error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('200 with users + project counts merged', async () => {
    listUsersResponse = {
      data: {
        users: [
          { id: 'u-1', email: 'a@x.com', created_at: '2026-01-01', last_sign_in_at: '2026-05-01' },
          { id: 'u-2', email: 'b@x.com', created_at: '2026-02-01', last_sign_in_at: null },
          { id: 'u-3', email: 'c@x.com', created_at: '2026-03-01', last_sign_in_at: null },
        ],
        total: 3,
      },
      error: null,
    }
    projectCountRows = [
      { user_id: 'u-1', project_count: 5 },
      { user_id: 'u-2', project_count: 1 },
      // u-3 has zero projects → not in the GROUP BY result
    ]
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.users).toEqual([
      { id: 'u-1', email: 'a@x.com', created_at: '2026-01-01', last_sign_in_at: '2026-05-01', project_count: 5 },
      { id: 'u-2', email: 'b@x.com', created_at: '2026-02-01', last_sign_in_at: null, project_count: 1 },
      { id: 'u-3', email: 'c@x.com', created_at: '2026-03-01', last_sign_in_at: null, project_count: 0 },
    ])
    expect(res.body.total).toBe(3)
    expect(res.body.page).toBe(1)
    expect(res.body.perPage).toBe(50)
  })

  it('skips the count query when Supabase returns zero users', async () => {
    listUsersResponse = { data: { users: [], total: 0 }, error: null }
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.users).toEqual([])
    // Empty IN () would be invalid SQL — guard relies on this skip.
    expect(capturedSql).toHaveLength(0)
  })

  it('caps perPage at 200', async () => {
    listUsersResponse = { data: { users: [] }, error: null }
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: { perPage: '9999' }, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.body.perPage).toBe(200)
  })

  it('502 when Supabase returns an error', async () => {
    listUsersResponse = { data: null, error: { message: 'invalid_credentials' } }
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: {} }
    const res = makeRes()
    await runChain(listHandlers, req, res)
    expect(res.statusCode).toBe(502)
    expect(res.body.error).toMatch(/invalid_credentials/)
  })
})

describe('GET /api/admin/users/:userId (detail)', () => {
  it('401 when unauthenticated', async () => {
    const req = { auth: null, query: {}, params: { userId: 'u-1' } }
    const res = makeRes()
    await runChain(detailHandlers, req, res)
    expect(res.statusCode).toBe(401)
  })

  it('403 when non-admin', async () => {
    const req = { auth: { userId: 'u-x', isAdmin: false }, query: {}, params: { userId: 'u-1' } }
    const res = makeRes()
    await runChain(detailHandlers, req, res)
    expect(res.statusCode).toBe(403)
  })

  it('404 when Supabase has no such user', async () => {
    getUserByIdResponse = { data: { user: null }, error: null }
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: { userId: 'u-MISSING' } }
    const res = makeRes()
    await runChain(detailHandlers, req, res)
    expect(res.statusCode).toBe(404)
  })

  it('200 with user + projects when user exists', async () => {
    getUserByIdResponse = {
      data: {
        user: {
          id: 'u-1', email: 'a@x.com', created_at: '2026-01-01',
          last_sign_in_at: '2026-05-01', email_confirmed_at: '2026-01-01',
          app_metadata: { provider: 'email' }, user_metadata: { name: 'A' },
        },
      },
      error: null,
    }
    projectsForUser = [
      { id: 10, name: 'Project A', created_at: '2026-04-01', assembly_status: 'done',
        rough_cut_status: 'done', broll_chain_status: 'done', broll_chain_substage: null,
        path_id: 'guided', auto_rough_cut: 0 },
      { id: 11, name: 'Project B', created_at: '2026-03-01', assembly_status: null,
        rough_cut_status: null, broll_chain_status: null, broll_chain_substage: null,
        path_id: null, auto_rough_cut: 1 },
    ]
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: { userId: 'u-1' } }
    const res = makeRes()
    await runChain(detailHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.user.id).toBe('u-1')
    expect(res.body.user.email).toBe('a@x.com')
    expect(res.body.projects).toEqual(projectsForUser)
    // SQL should filter user_id and parent_group_id IS NULL.
    expect(capturedSql.join('\n')).toMatch(/parent_group_id IS NULL/)
  })

  it('502 when Supabase returns an error on getUserById', async () => {
    getUserByIdResponse = { data: null, error: { message: 'auth_error' } }
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: { userId: 'u-1' } }
    const res = makeRes()
    await runChain(detailHandlers, req, res)
    expect(res.statusCode).toBe(502)
  })
})

describe('POST /api/admin/users/:userId/impersonate', () => {
  it('401 when unauthenticated', async () => {
    const req = { auth: null, query: {}, params: { userId: 'u-1' }, body: {} }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(401)
  })

  it('403 when non-admin', async () => {
    const req = { auth: { userId: 'u-1', isAdmin: false }, query: {}, params: { userId: 'u-2' }, body: {} }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(403)
  })

  it('503 when service-role key not configured', async () => {
    supabaseConfigured = false
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: { userId: 'u-1' }, body: {} }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(503)
  })

  it('404 when target user does not exist', async () => {
    getUserByIdResponse = { data: { user: null }, error: null }
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: { userId: 'u-MISSING' }, body: {} }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('404 when target has no email (e.g. phone-only auth)', async () => {
    getUserByIdResponse = { data: { user: { id: 'u-1', email: null } }, error: null }
    const req = { auth: { userId: 'u-admin', isAdmin: true }, query: {}, params: { userId: 'u-1' }, body: {} }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(404)
    expect(res.body.error).toMatch(/no email/i)
  })

  it('200 returns action_link when Supabase mints one', async () => {
    getUserByIdResponse = { data: { user: { id: 'u-1', email: 'user@x.com' } }, error: null }
    generateLinkResponse = {
      data: { properties: { action_link: 'https://wymmywshkimzbxbmpukp.supabase.co/auth/v1/verify?token=abc&type=magiclink' } },
      error: null,
    }
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { userId: 'u-1' },
      body: { redirect_to: 'https://app.example.com/' },
    }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.action_link).toBe('https://wymmywshkimzbxbmpukp.supabase.co/auth/v1/verify?token=abc&type=magiclink')
    expect(res.body.email).toBe('user@x.com')
    // generateLink called with the right shape
    expect(generateLinkCalls).toHaveLength(1)
    expect(generateLinkCalls[0]).toEqual({
      type: 'magiclink',
      email: 'user@x.com',
      options: { redirectTo: 'https://app.example.com/' },
    })
  })

  it('omits redirectTo when body has none', async () => {
    getUserByIdResponse = { data: { user: { id: 'u-1', email: 'user@x.com' } }, error: null }
    generateLinkResponse = {
      data: { properties: { action_link: 'https://x/auth/v1/verify?t=1' } },
      error: null,
    }
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { userId: 'u-1' },
      body: {},
    }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(200)
    expect(generateLinkCalls[0].options).toEqual({})
  })

  it('502 when Supabase generateLink errors', async () => {
    getUserByIdResponse = { data: { user: { id: 'u-1', email: 'user@x.com' } }, error: null }
    generateLinkResponse = { data: null, error: { message: 'rate_limit_exceeded' } }
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { userId: 'u-1' }, body: {},
    }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(502)
    expect(res.body.error).toMatch(/rate_limit_exceeded/)
  })

  it('502 when Supabase returns no action_link', async () => {
    getUserByIdResponse = { data: { user: { id: 'u-1', email: 'user@x.com' } }, error: null }
    generateLinkResponse = { data: { properties: {} }, error: null }
    const req = {
      auth: { userId: 'u-admin', isAdmin: true },
      query: {}, params: { userId: 'u-1' }, body: {},
    }
    const res = makeRes()
    await runChain(impersonateHandlers, req, res)
    expect(res.statusCode).toBe(502)
    expect(res.body.error).toMatch(/action_link/)
  })
})
