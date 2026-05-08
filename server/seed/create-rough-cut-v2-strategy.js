// server/seed/create-rough-cut-v2-strategy.js
//
// Inserts the auto_v2 strategy + version 1 with is_main = 0.
// Strategy 27 keeps is_main = 1 — see spec §Beta deployment plan
// (docs/superpowers/specs/2026-05-07-rough-cut-v2-agent-design.md).
// Idempotent: rerun-safe.
//
// Run via: node --env-file=.env server/seed/create-rough-cut-v2-strategy.js

import db from '../db.js'

const NAME = 'auto_v2'
const DESCRIPTION = 'Rough Cut V2 — Opus 4.7 single-agent with 12 tools. Beta. See docs/superpowers/specs/2026-05-07-rough-cut-v2-agent-design.md.'
const STAGES = [
  {
    name: 'Agent',
    type: 'agent',
    model: 'claude-opus-4-7',
    notes: 'Single Opus 4.7 agent with tool use. Outputs cut records with category, confidence, evidence.',
  },
]

async function main() {
  const existing = await db.prepare('SELECT id, is_main FROM strategies WHERE name = ?').get(NAME)
  let strategyId
  if (existing) {
    console.log(`[seed:auto_v2] strategy "${NAME}" already exists (id=${existing.id}, is_main=${existing.is_main})`)
    if (existing.is_main !== 0 && existing.is_main !== false) {
      console.warn(`[seed:auto_v2] WARNING: is_main is not 0. Spec requires is_main=0 until manual evaluation passes.`)
    }
    strategyId = existing.id
  } else {
    const r = await db.prepare(
      'INSERT INTO strategies (name, description, is_main) VALUES (?, ?, 0)'
    ).run(NAME, DESCRIPTION)
    strategyId = Number(r.lastInsertRowid)
    console.log(`[seed:auto_v2] inserted strategy ${strategyId}`)
  }

  const v1 = await db.prepare(
    'SELECT id FROM strategy_versions WHERE strategy_id = ? AND version_number = 1'
  ).get(strategyId)
  if (v1) {
    console.log(`[seed:auto_v2] version 1 already exists (id=${v1.id})`)
  } else {
    const r = await db.prepare(
      'INSERT INTO strategy_versions (strategy_id, version_number, stages_json, notes) VALUES (?, 1, ?, ?)'
    ).run(strategyId, JSON.stringify(STAGES), 'Initial v1 — beta')
    console.log(`[seed:auto_v2] inserted strategy_version ${r.lastInsertRowid}`)
  }

  console.log('[seed:auto_v2] done')
  process.exit(0)
}

main().catch(err => {
  console.error('[seed:auto_v2] failed:', err)
  process.exit(1)
})
