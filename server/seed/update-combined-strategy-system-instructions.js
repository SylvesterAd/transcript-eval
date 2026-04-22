import db from '../db.js'

// Load the system instruction from the plan strategy's Create B-Roll strategy stage
const planStrategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'plan' ORDER BY id LIMIT 1").get()
const planVersion = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(planStrategy.id)
const planStages = JSON.parse(planVersion.stages_json)

// Stage 6 (index 5) = Create B-Roll strategy — has the full system instruction
const strategySystemInstruction = planStages[5].system_instruction || ''
console.log('Plan strategy stage 6 system instruction length:', strategySystemInstruction.length, 'chars')

// Load combined strategy
const combined = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1").get()
if (!combined) { console.error('No create_combined_strategy found'); process.exit(1) }

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(combined.id)
const stages = JSON.parse(ver.stages_json)

// Stage 1 (Select best beats): Keep concise system instruction — it's a selection task, not a creation task
// But add context about what the categories mean so it can evaluate strategy_points accurately
stages[0].system_instruction = `You are a senior video editor selecting the best B-Roll approaches from multiple reference videos. Your goal is to find the best visual strategy for each beat by comparing across ALL available references.

# Understanding the categories in reference analyses:
A-roll: Primary footage (talking head/interview).
B-roll: Supporting footage to illustrate narration or cover A-roll.
Graphic package / PiP: Layout template with A-roll in a box plus branded design elements.
Overlay images: Non-text visual elements layered on top of A-roll (icons, logos, arrows, product images).

Output ONLY valid JSON. No commentary.`

// Stage 2 (Create combined strategy): Use the FULL system instruction from the plan strategy
stages[1].system_instruction = strategySystemInstruction

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)
console.log('Updated create_combined_strategy system instructions:')
console.log('  Stage 1 (Select beats): ' + stages[0].system_instruction.length + ' chars')
console.log('  Stage 2 (Create strategy): ' + stages[1].system_instruction.length + ' chars — copied from plan strategy')
process.exit(0)
