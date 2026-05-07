import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { group: null, strategy: null, version: null, video: null,
  insertedExperimentId: null, insertedRunId: null, executeRunCalled: false }

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get() {
          if (/SELECT \* FROM video_groups WHERE id/.test(sql)) return state.group
          if (/SELECT \* FROM strategies WHERE id/.test(sql)) return state.strategy
          if (/SELECT \* FROM strategy_versions WHERE strategy_id/.test(sql)) return state.version
          if (/SELECT v\.\* FROM videos v/.test(sql)) return state.video
          return null
        },
        async run() {
          if (/INSERT INTO experiments/.test(sql)) {
            state.insertedExperimentId = 77
            return { lastInsertRowid: 77 }
          }
          if (/INSERT INTO experiment_runs/.test(sql)) {
            state.insertedRunId = 88
            return { lastInsertRowid: 88 }
          }
          return { changes: 0 }
        },
      }
    },
  },
}))

vi.mock('../../auth.js', () => ({
  requireAuth: (req, res, next) => next(),
  isAdmin: () => true,
}))

vi.mock('../../services/llm-runner.js', () => ({
  executeRun: vi.fn().mockImplementation(async () => { state.executeRunCalled = true }),
}))

beforeEach(() => {
  state.group = { id: 1, user_id: 'u1' }
  state.strategy = { id: 99, name: 'auto_v2', is_main: 0 }
  state.version = { id: 100, strategy_id: 99, stages_json: '[{"name":"Agent","type":"agent","model":"claude-opus-4-7"}]' }
  state.video = { id: 200, group_id: 1, video_type: 'raw' }
  state.insertedExperimentId = null
  state.insertedRunId = null
  state.executeRunCalled = false
})

function makeReqRes(body) {
  return {
    req: { params: { id: '1' }, body, auth: { userId: 'admin', email: 'silvestras.stonk@gmail.com' } },
    res: {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this },
      json(j) { this.body = j; return this },
    },
  }
}

async function runRoute(handlers, req, res) {
  for (const h of handlers) {
    if (res.body) return
    await new Promise((resolve, reject) => {
      const next = (e) => e ? reject(e) : resolve()
      const ret = h(req, res, next)
      if (ret?.then) ret.then(() => resolve(), reject)
    })
  }
}

describe('POST /admin/groups/:id/run-strategy', () => {
  it('inserts experiment + experiment_run and kicks off executeRun without touching annotations', async () => {
    const router = (await import('../admin.js')).default
    const layer = router.stack.find(l => l.route?.path === '/groups/:id/run-strategy' && l.route.methods.post)
    expect(layer).toBeDefined()

    const { req, res } = makeReqRes({ strategy_id: 99 })
    await runRoute(layer.route.stack.map(s => s.handle), req, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.runId).toBe(88)
    expect(res.body.experimentId).toBe(77)
    // background fire — give it a tick
    await new Promise(r => setTimeout(r, 20))
    expect(state.executeRunCalled).toBe(true)
  })

  it('returns 404 when group missing', async () => {
    state.group = null
    const router = (await import('../admin.js')).default
    const layer = router.stack.find(l => l.route?.path === '/groups/:id/run-strategy' && l.route.methods.post)
    const { req, res } = makeReqRes({ strategy_id: 99 })
    await runRoute(layer.route.stack.map(s => s.handle), req, res)
    expect(res.statusCode).toBe(404)
  })

  it('returns 400 when strategy_id missing', async () => {
    const router = (await import('../admin.js')).default
    const layer = router.stack.find(l => l.route?.path === '/groups/:id/run-strategy' && l.route.methods.post)
    const { req, res } = makeReqRes({})
    await runRoute(layer.route.stack.map(s => s.handle), req, res)
    expect(res.statusCode).toBe(400)
  })
})
