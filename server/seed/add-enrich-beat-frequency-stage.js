import db from '../db.js'

const enrichStage = {
  name: 'Enrich beat frequency data',
  type: 'programmatic',
  target: 'text_only',
  action: 'enrich_beat_frequency',
  actionParams: {},
  description: 'Add per-beat frequency stats (broll_per_minute, avg_duration) from the matched reference analysis beats',
}

// === Strategy 8 (create_strategy) ===
const strategy8 = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1").get()
if (strategy8) {
  const ver8 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy8.id)
  const stages8 = JSON.parse(ver8.stages_json)

  // Check if already added
  if (!stages8.some(s => s.action === 'enrich_beat_frequency')) {
    stages8.push(enrichStage)
    await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages8), ver8.id)
    console.log(`Strategy 8 (create_strategy): added enrich_beat_frequency stage (now ${stages8.length} stages)`)
  } else {
    console.log('Strategy 8: enrich_beat_frequency already exists')
  }
}

// === Strategy 10 (create_combined_strategy) ===
const strategy10 = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1").get()
if (strategy10) {
  const ver10 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy10.id)
  const stages10 = JSON.parse(ver10.stages_json)

  if (!stages10.some(s => s.action === 'enrich_beat_frequency')) {
    stages10.push(enrichStage)
    await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages10), ver10.id)
    console.log(`Strategy 10 (create_combined_strategy): added enrich_beat_frequency stage (now ${stages10.length} stages)`)
  } else {
    console.log('Strategy 10: enrich_beat_frequency already exists')
  }
}

process.exit(0)
