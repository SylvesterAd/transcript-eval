import db from '../db.js'

// Update plan_prep strategy Stage 4 — remove emotion from output rules and JSON example
const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 7 ORDER BY created_at DESC LIMIT 1').get()
if (!ver) { console.error('No plan_prep version found'); process.exit(1) }

const stages = JSON.parse(ver.stages_json)

// Stage 4 (index 3) = Analyze Chapters & Beats
stages[3].prompt = stages[3].prompt
  // Remove emotion from output rules
  .replace(
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer
- "emotion": 1-2 sentences describing what the viewer is meant to FEEL during this chapter/beat — the emotional journey (e.g. curiosity, fear, relief, excitement, empathy, urgency)`,
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer`
  )
  // Remove emotion from chapter example
  .replace(
    `      "purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "emotion": "Anxiety and dread — the viewer should feel personally threatened, like the ground is shifting under their feet.",
      "beats"`,
    `      "purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "beats"`
  )
  // Remove emotion from beat example
  .replace(
    `          "purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention.",
          "emotion": "Shock and urgency — a gut punch that makes the viewer think 'this applies to ME'."`,
    `          "purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention."`
  )

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)

// Verify
const check = JSON.parse(stages[3].prompt.includes('emotion') ? '"STILL HAS EMOTION"' : '"CLEAN"')
console.log('plan_prep Stage 4 emotion removed:', check)
process.exit(0)
