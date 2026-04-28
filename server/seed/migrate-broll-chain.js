// One-shot migration to add b-roll chain + notification columns to video_groups.
// Idempotent — safe to run multiple times.
// Run via: node --env-file=.env server/seed/migrate-broll-chain.js

import db from '../db.js'

async function run() {
  await db.prepare(`
    ALTER TABLE video_groups
      ADD COLUMN IF NOT EXISTS broll_chain_status TEXT,
      ADD COLUMN IF NOT EXISTS broll_chain_error TEXT,
      ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ
  `).run()
  console.log('[migrate] broll-chain columns ensured on video_groups')
  process.exit(0)
}

run().catch(err => { console.error('[migrate] failed:', err); process.exit(1) })
