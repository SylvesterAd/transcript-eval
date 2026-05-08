import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted so the mock factory can reference these before the module is loaded.
// mockPrepare is pre-configured with a safe default so the module-level
// db.prepare("UPDATE experiment_runs …").run() in llm-runner.js succeeds at
// import time.
const { mockPrepare, savedStates, mockPoolConnect } = vi.hoisted(() => {
  const savedStates = new Map()
  const mockPoolConnect = vi.fn()

  // Default stub: handles the llm-runner.js module-level initializer which
  // calls db.prepare(sql).run() synchronously (top-level await).
  const mockPrepare = vi.fn().mockImplementation((sql) => ({
    run: vi.fn().mockReturnValue({ changes: 0 }),
    get: vi.fn().mockReturnValue(null),
    all: vi.fn().mockReturnValue([]),
  }))

  return { mockPrepare, savedStates, mockPoolConnect }
})

vi.mock('../../db.js', () => ({
  default: {
    prepare: (...a) => mockPrepare(...a),
    pool: { connect: (...a) => mockPoolConnect(...a) },
  },
}))

import { getBRollEditorData } from '../broll.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────

const planPipelineId = 'plan-518-test'
const groupId = 374
const videoId = 518

const chapterRun = {
  id: 1,
  metadata_json: JSON.stringify({
    pipelineId: planPipelineId,
    isSubRun: true,
    stageName: 'Per-chapter B-Roll plan',
    subIndex: 0,
  }),
  output_text: JSON.stringify({
    placements: [{
      start: '[00:00:14.94]', end: '[00:00:16.94]', // already post-cut (Task 1 invariant)
      audio_anchor: 'There is a bad piece',
      anchor_word_idx: 0,
    }],
  }),
}

const rawWords = [
  { word: 'There', start: 19.94, end: 20.10 },
  { word: 'is',    start: 20.10, end: 20.18 },
]

// ─── Mock client factory ──────────────────────────────────────────────────

// Builds a mock pg-client for pool.connect(). saveBrollEditorState does:
//   client.query('BEGIN')
//   client.query(`SELECT ... FOR UPDATE`, [planPipelineId]) → { rows: [...] }
//   client.query(INSERT or UPDATE, [stateJson, version, planPipelineId])
//   client.query('COMMIT')
//   client.release()
//
// When simulatePersist=true, the INSERT/UPDATE path updates savedStates so
// a subsequent loadBrollEditorState() call (via db.prepare().get()) sees the
// newly saved state. This is the default for the "first call runs remap" test.
function makeMockClient({ forUpdateRows = [], onWrite = null, simulatePersist = false } = {}) {
  return {
    query: vi.fn().mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {}
      if (sql.includes('FOR UPDATE')) return { rows: forUpdateRows }
      // INSERT or UPDATE from saveBrollEditorState
      if (simulatePersist && params && (sql.includes('INSERT INTO broll_editor_state') || sql.includes('UPDATE broll_editor_state'))) {
        // params for INSERT: [planPipelineId, stateJson, nextVersion]
        // params for UPDATE: [stateJson, nextVersion, planPipelineId]
        let stateJson, version, pid
        if (sql.includes('INSERT INTO')) {
          ;[pid, stateJson, version] = params
        } else {
          ;[stateJson, version, pid] = params
        }
        savedStates.set(pid, { state_json: stateJson, version })
      }
      if (onWrite) onWrite(sql)
      return { rows: [] }
    }),
    release: vi.fn(),
  }
}

// ─── prepare() implementation factory ────────────────────────────────────

// Returns a function suitable for mockPrepare.mockImplementation() that covers
// all SQL paths exercised by getBRollEditorData.
function makePrepareImpl({ onWrite = null } = {}) {
  return (sql) => {
    // Module-level initializer in llm-runner.js (synchronous `.run()`)
    if (sql.includes('UPDATE experiment_runs')) {
      return { run: vi.fn().mockReturnValue({ changes: 0 }) }
    }

    return {
      all: vi.fn().mockImplementation(async () => {
        // Main plan sub-runs lookup (non-LIKE variant)
        if (sql.includes('FROM broll_runs') && sql.includes("'pipelineId'") && !sql.includes('LIKE')) {
          return [chapterRun]
        }
        // broll_searches, kw- runs, bs- runs, search logs — empty for this fixture
        return []
      }),
      get: vi.fn().mockImplementation(async () => {
        // video_groups join — remap pass reads cuts from here
        if (sql.includes('FROM video_groups')) {
          return {
            id: groupId,
            editor_state_json: JSON.stringify({
              cuts: [{ start: 10, end: 15 }],
              cutExclusions: [],
            }),
          }
        }
        // Transcript raw words — remap pass reads from here
        if (sql.includes('FROM transcripts')) {
          return { word_timestamps_json: JSON.stringify(rawWords) }
        }
        // broll_editor_state — loadBrollEditorState reads state_json + version
        if (sql.includes('FROM broll_editor_state')) {
          const stored = savedStates.get(planPipelineId)
          if (!stored) return null
          return { state_json: stored.state_json, version: stored.version }
        }
        // video_id lookup for transcript fetch (JOIN videos JOIN broll_runs)
        if (sql.includes('FROM videos') && sql.includes('broll_runs')) {
          return { video_id: videoId }
        }
        return null
      }),
      run: vi.fn().mockImplementation(async (...args) => {
        if (onWrite) onWrite(sql, args)
        return { changes: 1, lastInsertRowid: 1 }
      }),
    }
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  savedStates.clear()
  mockPrepare.mockReset()
  mockPrepare.mockImplementation(makePrepareImpl())

  mockPoolConnect.mockReset()
  // Default: no prior row (INSERT path), simulatePersist so loadBrollEditorState
  // after save sees the freshly written state (remappedPositions).
  mockPoolConnect.mockResolvedValue(makeMockClient({ forUpdateRows: [], simulatePersist: true }))
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('getBRollEditorData hash-diff remap', () => {
  it('runs the remap on first call (no stored hash) and returns post-cut times', async () => {
    const data = await getBRollEditorData(planPipelineId)
    expect(data.placements).toHaveLength(1)
    const p = data.placements[0]
    // userTimelineStart should be the remapped post-cut time.
    expect(p.userTimelineStart).toBeCloseTo(14.94, 1)
    expect(p.userTimelineEnd).toBeCloseTo(16.94, 1)
  })

  it('does not re-run remap when cuts hash is unchanged', async () => {
    const { cutsHash: hashFn } = await import('../placement-remap.js')
    const storedHash = hashFn([{ start: 10, end: 15 }], [])

    const storedState = {
      lastRemappedCutsHash: storedHash,
      remappedPositions: {
        'whatever-uuid': { start_seconds: 14.94, end_seconds: 16.94, anchor_state: 'idx' },
      },
    }
    savedStates.set(planPipelineId, { state_json: JSON.stringify(storedState), version: 7 })

    let savedAgain = false

    // Track writes to broll_editor_state only — that's what the remap path saves.
    // (ensurePlanUuids does INSERT INTO broll_placement_uuids which is expected.)
    const trackWrite = (sql) => {
      if (sql.includes('broll_editor_state')) savedAgain = true
    }

    mockPrepare.mockReset()
    mockPrepare.mockImplementation(makePrepareImpl({ onWrite: trackWrite }))

    mockPoolConnect.mockReset()
    // pool.connect onWrite: only trigger if the INSERT/UPDATE touches broll_editor_state
    mockPoolConnect.mockResolvedValue(makeMockClient({
      forUpdateRows: [{ state_json: JSON.stringify(storedState), version: 7 }],
      onWrite: (sql) => { if (sql.includes('broll_editor_state')) savedAgain = true },
    }))

    await getBRollEditorData(planPipelineId)
    expect(savedAgain).toBe(false)
  })
})
