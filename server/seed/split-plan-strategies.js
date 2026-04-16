import db from '../db.js'

// Load current plan strategy version
const planStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'plan' ORDER BY id LIMIT 1").get()
if (!planStrategy) { console.error('No plan strategy found'); process.exit(1) }

const planVersion = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(planStrategy.id)
if (!planVersion) { console.error('No plan version found'); process.exit(1) }

const allStages = JSON.parse(planVersion.stages_json)
console.log(`Source: strategy ${planStrategy.id} "${planStrategy.name}" with ${allStages.length} stages`)

// Split stages
const prepStages = allStages.slice(0, 5)     // stages 0-4
const strategyStages = [allStages[5]]         // stage 5 only
const planStages = allStages.slice(6)         // stages 6-7

// Fix actionParams indices for create_plan stages (they referenced absolute indices in the 8-stage array)
// Stage 7 (now index 1 in create_plan) has assemble_broll_plan with strategyStageIndex:5
// In the new pipeline, the strategy comes from a different pipeline, so we'll handle it in executeCreatePlan
// For now, keep the stage as-is — the execute function will override the data source

console.log(`  plan_prep: ${prepStages.length} stages (${prepStages.map(s => s.name).join(', ')})`)
console.log(`  create_strategy: ${strategyStages.length} stages (${strategyStages.map(s => s.name).join(', ')})`)
console.log(`  create_plan: ${planStages.length} stages (${planStages.map(s => s.name).join(', ')})`)

// Check if strategies already exist (idempotent)
const existing = await db.prepare("SELECT strategy_kind FROM broll_strategies WHERE strategy_kind IN ('plan_prep', 'create_strategy', 'create_plan')").all()
if (existing.length) {
  console.log('Strategies already exist:', existing.map(e => e.strategy_kind).join(', '))
  console.log('Skipping creation (idempotent)')
  process.exit(0)
}

// Create plan_prep strategy
const prepResult = await db.prepare(`
  INSERT INTO broll_strategies (name, description, strategy_kind)
  VALUES ($1, $2, $3)
`).run('Plan Prep', 'Prepare main video for B-Roll planning: generate post-cut transcript, export video, analyze A-Roll, detect chapters & beats, split by chapter', 'plan_prep')
const prepStrategyId = prepResult.lastInsertRowid

await db.prepare(`
  INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
  VALUES ($1, $2, $3, $4)
`).run(prepStrategyId, 'Version 1', 'Extracted from plan strategy stages 1-5', JSON.stringify(prepStages))
console.log(`Created plan_prep strategy (id=${prepStrategyId})`)

// Create create_strategy strategy
const stratResult = await db.prepare(`
  INSERT INTO broll_strategies (name, description, strategy_kind)
  VALUES ($1, $2, $3)
`).run('Create B-Roll Strategy', 'Generate per-chapter B-Roll strategy based on reference video analysis', 'create_strategy')
const stratStrategyId = stratResult.lastInsertRowid

await db.prepare(`
  INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
  VALUES ($1, $2, $3, $4)
`).run(stratStrategyId, 'Version 1', 'Extracted from plan strategy stage 6', JSON.stringify(strategyStages))
console.log(`Created create_strategy strategy (id=${stratStrategyId})`)

// Create create_plan strategy
const planResult = await db.prepare(`
  INSERT INTO broll_strategies (name, description, strategy_kind)
  VALUES ($1, $2, $3)
`).run('Create B-Roll Plan', 'Generate per-chapter B-Roll placements from a chosen strategy', 'create_plan')
const planNewStrategyId = planResult.lastInsertRowid

await db.prepare(`
  INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
  VALUES ($1, $2, $3, $4)
`).run(planNewStrategyId, 'Version 1', 'Extracted from plan strategy stages 7-8', JSON.stringify(planStages))
console.log(`Created create_plan strategy (id=${planNewStrategyId})`)

console.log('\nDone — 3 new strategies created')
process.exit(0)
