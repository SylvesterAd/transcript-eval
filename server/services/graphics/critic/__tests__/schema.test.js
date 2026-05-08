import { describe, it, expect } from 'vitest'

const skip = !process.env.DATABASE_URL
const d = skip ? describe.skip : describe

let db
async function getDb() {
  if (!db) db = (await import('../../../../db.js')).default
  return db
}

d('graphics_render_iterations table + render columns', () => {
  it('graphics_render_iterations exists with expected columns', async () => {
    const p = (await getDb()).pool
    const { rows } = await p.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'graphics_render_iterations' ORDER BY ordinal_position"
    )
    const cols = rows.map((r) => r.column_name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'render_id', 'iteration_index', 'mp4_path', 'frame_urls_json',
        'critic_score', 'critic_criteria_json', 'critic_feedback', 'created_at',
      ])
    )
  })

  it('graphics_renders has iteration_count + final_score columns', async () => {
    const p = (await getDb()).pool
    const { rows } = await p.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'graphics_renders'"
    )
    const cols = rows.map((r) => r.column_name)
    expect(cols).toContain('iteration_count')
    expect(cols).toContain('final_score')
  })
})
