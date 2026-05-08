import { describe, it, expect, beforeAll } from 'vitest'

const skip = !process.env.DATABASE_URL
const d = skip ? describe.skip : describe

d('rough-cut v2 schema migration', () => {
  let db
  beforeAll(async () => {
    db = (await import('../../db.js')).default
  })

  it('deletion_annotations has category column', async () => {
    const { rows } = await db.pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'deletion_annotations' AND column_name = 'category'
    `)
    expect(rows.length).toBe(1)
  })

  it('deletion_annotations has confidence column (REAL)', async () => {
    const { rows } = await db.pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'deletion_annotations' AND column_name = 'confidence'
    `)
    expect(rows.length).toBe(1)
    expect(rows[0].data_type).toBe('real')
  })

  it('deletion_annotations has evidence_json column', async () => {
    const { rows } = await db.pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'deletion_annotations' AND column_name = 'evidence_json'
    `)
    expect(rows.length).toBe(1)
  })
})
