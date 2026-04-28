// One-shot migration to add Auto Rough Cut columns to video_groups.
// Idempotent — safe to run multiple times.
// Run via: node --env-file=.env server/seed/migrate-auto-rough-cut.js
import db from '../db.js'

async function run() {
  await db.prepare(`
    ALTER TABLE video_groups
      ADD COLUMN IF NOT EXISTS auto_rough_cut BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS rough_cut_status TEXT,
      ADD COLUMN IF NOT EXISTS rough_cut_error_required INTEGER
  `).run()
  console.log('[migrate] auto-rough-cut columns ensured on video_groups')
  process.exit(0)
}

run().catch(err => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
