import db from '../db.js'

const strat = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1").get()
if (!strat) { console.error('No create_combined_strategy found'); process.exit(1) }

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strat.id)
const stages = JSON.parse(ver.stages_json)

const stage1 = stages[1]
if (!stage1) { console.error('No stage 1 found'); process.exit(1) }

let changed = false

if (stage1.prompt?.includes('{{all_reference_analyses}}')) {
  stage1.prompt = stage1.prompt.replace(/\{\{all_reference_analyses\}\}/g, '{{all_reference_analyses_slim}}')
  changed = true
}
if (stage1.system_instruction?.includes('{{all_reference_analyses}}')) {
  stage1.system_instruction = stage1.system_instruction.replace(/\{\{all_reference_analyses\}\}/g, '{{all_reference_analyses_slim}}')
  changed = true
}

if (!changed) { console.log('Stage 1 already uses slim version'); process.exit(0) }

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)

console.log(`Combined strategy (id=${strat.id}) Stage 1 updated: {{all_reference_analyses}} → {{all_reference_analyses_slim}}`)
process.exit(0)
