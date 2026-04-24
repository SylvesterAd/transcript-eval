// Service-layer tests for writeExportResult.
//
// Strategy: mock server/db.js at the module boundary. `writeExportResult`
// does (a) a read via `db.prepare('SELECT id, user_id FROM exports WHERE id = ?').get(id)`
// and (b) a write via `db.prepare('UPDATE exports SET result_json = ? WHERE id = ?').run(payload, id)`.
// The fake DB records calls and returns scripted rows.
//
// Why mock instead of a real test DB: the project has no test-db fixture
// today and the writer's logic is validation + single SELECT + single
// UPDATE — nothing pg-specific to exercise. If a round-trip test ever
// needs real pg semantics (serialization, concurrent updates), add it
// then; we don't pre-invest.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake db state. Tests mutate this in beforeEach.
const rows = new Map() // id -> { id, user_id, result_json, status?, folder_path? }

// Hoisted mock BEFORE the service import. vi.mock is auto-hoisted by
// vitest; the factory runs before any `import` in this file resolves.
vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(id) {
          if (/SELECT .* FROM exports WHERE id = \?/i.test(sql)) {
            return rows.get(id) || null
          }
          throw new Error(`unexpected .get SQL: ${sql}`)
        },
        async run(...args) {
          if (/^UPDATE exports SET result_json = \?/i.test(sql)) {
            const [payload, id] = args
            const row = rows.get(id)
            if (!row) return { changes: 0 }
            rows.set(id, { ...row, result_json: payload })
            return { changes: 1 }
          }
          throw new Error(`unexpected .run SQL: ${sql}`)
        },
      }
    },
  },
}))

// Stub the slack notifier — recordExportEvent imports it transitively
// but writeExportResult doesn't call it. Still safer to mute side effects.
vi.mock('../slack-notifier.js', () => ({ notify: vi.fn() }))

// Import AFTER mock declaration.
const mod = await import('../exports.js')
const { writeExportResult, getExportResult, ValidationError, NotFoundError } = mod

beforeEach(() => {
  rows.clear()
})

describe('writeExportResult', () => {
  const baseVariants = [
    {
      label: 'A',
      sequenceName: 'Variant A',
      placements: [
        {
          seq: 1,
          source: 'envato',
          sourceItemId: 'NX9WYGQ',
          filename: '001_envato_NX9WYGQ.mov',
          timelineStart: 0,
          timelineDuration: 2.5,
        },
      ],
    },
  ]

  it('writes valid payload and round-trips via getExportResult', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    const result = await writeExportResult({
      id: 'exp_OK',
      userId: 'user-1',
      variants: baseVariants,
    })
    expect(result).toEqual({ ok: true })
    expect(rows.get('exp_OK').result_json).toBe(JSON.stringify({ variants: baseVariants }))

    // Round-trip via getExportResult. Since getExportResult reads a
    // different SELECT ('SELECT id, user_id, status, folder_path, result_json ...'),
    // extend the fake to accept it. Add columns to the row first.
    rows.set('exp_OK', { ...rows.get('exp_OK'), status: 'complete', folder_path: '~/Downloads/test' })
    const readBack = await getExportResult('exp_OK', { userId: 'user-1' })
    expect(readBack).toEqual({
      export_id: 'exp_OK',
      status: 'complete',
      folder_path: '~/Downloads/test',
      variants: baseVariants,
    })
  })

  it('404s when the export does not exist', async () => {
    await expect(
      writeExportResult({ id: 'exp_MISSING', userId: 'user-1', variants: baseVariants }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('404s when the export is owned by a different user', async () => {
    rows.set('exp_OTHER', { id: 'exp_OTHER', user_id: 'user-2', result_json: null })
    await expect(
      writeExportResult({ id: 'exp_OTHER', userId: 'user-1', variants: baseVariants }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('allows writes to null-owner exports (migration-era legacy)', async () => {
    rows.set('exp_NULLOWNER', { id: 'exp_NULLOWNER', user_id: null, result_json: null })
    const result = await writeExportResult({
      id: 'exp_NULLOWNER',
      userId: 'user-1',
      variants: baseVariants,
    })
    expect(result).toEqual({ ok: true })
    // The service is permissive on null-owner rows — same rule as
    // getExportResult. This test pins that behavior so a future
    // tightening is an explicit decision.
  })

  it('throws ValidationError on empty variants array', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    await expect(
      writeExportResult({ id: 'exp_OK', userId: 'user-1', variants: [] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError on missing variant.label', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    const bad = [{ ...baseVariants[0], label: '' }]
    await expect(
      writeExportResult({ id: 'exp_OK', userId: 'user-1', variants: bad }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError on placement with non-finite timelineStart', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    const bad = [{
      ...baseVariants[0],
      placements: [{ ...baseVariants[0].placements[0], timelineStart: Infinity }],
    }]
    await expect(
      writeExportResult({ id: 'exp_OK', userId: 'user-1', variants: bad }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError on placement with empty filename', async () => {
    rows.set('exp_OK', { id: 'exp_OK', user_id: 'user-1', result_json: null })
    const bad = [{
      ...baseVariants[0],
      placements: [{ ...baseVariants[0].placements[0], filename: '' }],
    }]
    await expect(
      writeExportResult({ id: 'exp_OK', userId: 'user-1', variants: bad }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is idempotent — re-writing the same shape yields the same stored JSON', async () => {
    rows.set('exp_IDEM', { id: 'exp_IDEM', user_id: 'user-1', result_json: null })
    await writeExportResult({ id: 'exp_IDEM', userId: 'user-1', variants: baseVariants })
    const firstWrite = rows.get('exp_IDEM').result_json
    await writeExportResult({ id: 'exp_IDEM', userId: 'user-1', variants: baseVariants })
    const secondWrite = rows.get('exp_IDEM').result_json
    expect(secondWrite).toBe(firstWrite)
  })
})
