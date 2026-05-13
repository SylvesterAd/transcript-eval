import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture every prepared statement and the args passed to .get()/.all().
const dbCalls = []
const dbState = {
  // Mocked rows by query-pattern. Tests set these per-case.
  planRunsRows: [],
  videoRow: null,
  groupRow: null,
}

vi.mock('../../db.js', () => ({
  default: {
    prepare: (sql) => ({
      get: (...args) => {
        dbCalls.push({ kind: 'get', sql, args })
        if (/SELECT group_id FROM videos/i.test(sql)) return dbState.videoRow
        if (/FROM video_groups vg/i.test(sql) || /FROM video_groups\b/i.test(sql)) return dbState.groupRow
        return null
      },
      all: (...args) => {
        dbCalls.push({ kind: 'all', sql, args })
        if (/FROM broll_runs/i.test(sql)) return dbState.planRunsRows
        return []
      },
      run: () => ({ rowCount: 1 }),
    }),
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) },
  },
}))

describe('resolveSourcesFromGroup (pure helper)', () => {
  it('returns ["envato"] for envato + freepik off — pexels is opt-in, not selected', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    const result = resolveSourcesFromGroup({ libraries_json: '["envato"]', freepik_opt_in: false })
    expect(result).toEqual(['envato'])
  })

  it('returns ["freepik"] when libraries_json is null and freepik default-on', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    const result = resolveSourcesFromGroup({ libraries_json: null, freepik_opt_in: true })
    expect(result).toEqual(['freepik'])
  })

  it('returns [] when libraries_json is null and freepik off (no auto-pexels baseline)', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: null, freepik_opt_in: false })).toEqual([])
  })

  it('treats freepik_opt_in === null as default-on (matches DB default)', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: null, freepik_opt_in: null })).toEqual(['freepik'])
  })

  it('passes "artlist" through (provider live since 2026-05)', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: '["artlist","envato","storyblocks"]', freepik_opt_in: false }))
      .toEqual(['artlist', 'envato', 'storyblocks'])
  })

  it('passes "artlist" through when it is the only library', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: '["artlist"]', freepik_opt_in: false }))
      .toEqual(['artlist'])
  })

  it('includes pexels when the user explicitly selected the no-subscriptions backup', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: '["pexels"]', freepik_opt_in: false }))
      .toEqual(['pexels'])
  })

  it('allows pexels alongside paid libs (user picked it as a backup)', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: '["envato","pexels"]', freepik_opt_in: false }))
      .toEqual(['envato', 'pexels'])
  })

  it('dedupes — never lists pexels twice if it appears in libraries multiple times', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: '["pexels","envato","pexels"]', freepik_opt_in: false }))
      .toEqual(['pexels', 'envato'])
  })

  it('accepts already-parsed object/array (defensive)', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: ['envato'], freepik_opt_in: false }))
      .toEqual(['envato'])
  })

  it('handles malformed JSON gracefully (returns empty when freepik also off)', async () => {
    const { resolveSourcesFromGroup } = await import('../broll.js')
    expect(resolveSourcesFromGroup({ libraries_json: 'not-json', freepik_opt_in: false }))
      .toEqual([])
  })
})

describe('resolveBrollSources — group lookup walks parent', () => {
  beforeEach(() => {
    dbCalls.length = 0
    dbState.planRunsRows = []
    dbState.videoRow = null
    dbState.groupRow = null
  })

  it('returns overrides.sources verbatim when provided', async () => {
    const { resolveBrollSources } = await import('../broll.js')
    const result = await resolveBrollSources('plan-x', { sources: ['envato', 'artlist', 'pexels'] })
    expect(result).toEqual(['envato', 'artlist', 'pexels'])
    // Should not have hit the database — overrides short-circuit.
    expect(dbCalls.length).toBe(0)
  })

  it('SQL JOINs the parent group so libraries_json comes from parent', async () => {
    const { resolveBrollSources } = await import('../broll.js')
    dbState.planRunsRows = [{ video_id: 410, metadata_json: JSON.stringify({ groupId: 269 }) }]
    dbState.groupRow = { libraries_json: '["envato"]', freepik_opt_in: false }

    const result = await resolveBrollSources('plan-x')

    // Confirm we hit the COALESCE-with-LEFT-JOIN query, not the legacy
    // single-table SELECT.
    const groupQuery = dbCalls.find(c => /FROM video_groups vg/i.test(c.sql))
    expect(groupQuery).toBeDefined()
    expect(groupQuery.sql).toMatch(/COALESCE\s*\(\s*parent\.libraries_json/i)
    expect(groupQuery.sql).toMatch(/COALESCE\s*\(\s*parent\.freepik_opt_in/i)
    expect(groupQuery.sql).toMatch(/LEFT JOIN video_groups parent ON parent\.id = vg\.parent_group_id/i)
    expect(groupQuery.args).toEqual([269])

    // Result reflects exactly what the user picked — no auto-pexels.
    expect(result).toEqual(['envato'])
  })

  it('falls back to videos.group_id when metadata.groupId is missing', async () => {
    const { resolveBrollSources } = await import('../broll.js')
    dbState.planRunsRows = [{ video_id: 410, metadata_json: '{}' }] // no groupId
    dbState.videoRow = { group_id: 269 }
    dbState.groupRow = { libraries_json: '["envato"]', freepik_opt_in: false }

    const result = await resolveBrollSources('plan-y')

    const videoQuery = dbCalls.find(c => /SELECT group_id FROM videos/i.test(c.sql))
    expect(videoQuery).toBeDefined()
    expect(videoQuery.args).toEqual([410])

    expect(result).toEqual(['envato'])
  })

  it('falls back to defaults (freepik default-on) when group lookup fails', async () => {
    const { resolveBrollSources } = await import('../broll.js')
    // Empty planRunsRows means we never resolve a groupId
    dbState.planRunsRows = []

    const result = await resolveBrollSources('plan-z')
    // No group → libraries empty, freepikOptIn defaults true, pexels NOT auto-added.
    expect(result).toEqual(['freepik'])
  })
})
