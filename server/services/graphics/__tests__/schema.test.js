// Integration test: verifies the three graphics_* tables exist in Postgres.
// Gates on DATABASE_URL — skipped in CI without a DB connection.
// Schema migrations are idempotent (IF NOT EXISTS), so safe against dev DB.

import { describe, it, expect } from 'vitest'

const skip = !process.env.DATABASE_URL
const d = skip ? describe.skip : describe

d('graphics tables', () => {
  let pool

  // Import db lazily so the module-load top-level await (migrations) runs
  // only when DATABASE_URL is present.
  async function getPool() {
    if (!pool) {
      const db = (await import('../../../db.js')).default
      pool = db.pool
    }
    return pool
  }

  it('graphics_sessions has expected columns', async () => {
    const p = await getPool()
    const { rows } = await p.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'graphics_sessions'
      ORDER BY column_name
    `)
    const cols = rows.map(r => r.column_name)
    expect(cols).toContain('id')
    expect(cols).toContain('user_id')
    expect(cols).toContain('user_email')
    expect(cols).toContain('title')
    expect(cols).toContain('spec_json')
    expect(cols).toContain('status')
    expect(cols).toContain('created_at')
    expect(cols).toContain('updated_at')
  })

  it('graphics_messages has expected columns', async () => {
    const p = await getPool()
    const { rows } = await p.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'graphics_messages'
      ORDER BY column_name
    `)
    const cols = rows.map(r => r.column_name)
    expect(cols).toContain('id')
    expect(cols).toContain('session_id')
    expect(cols).toContain('role')
    expect(cols).toContain('content')
    expect(cols).toContain('tool_calls_json')
    expect(cols).toContain('model_used')
    expect(cols).toContain('tokens_in')
    expect(cols).toContain('tokens_out')
    expect(cols).toContain('cost_cents')
    expect(cols).toContain('created_at')
  })

  it('graphics_renders has expected columns', async () => {
    const p = await getPool()
    const { rows } = await p.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'graphics_renders'
      ORDER BY column_name
    `)
    const cols = rows.map(r => r.column_name)
    expect(cols).toContain('id')
    expect(cols).toContain('session_id')
    expect(cols).toContain('iteration')
    expect(cols).toContain('spec_snapshot_json')
    expect(cols).toContain('template')
    expect(cols).toContain('status')
    expect(cols).toContain('output_url')
    expect(cols).toContain('preview_url')
    expect(cols).toContain('duration_ms')
    expect(cols).toContain('cost_cents')
    expect(cols).toContain('error_message')
    expect(cols).toContain('created_at')
  })
})
