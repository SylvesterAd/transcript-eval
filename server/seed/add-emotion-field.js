import db from '../db.js'

// ── Strategy 2: Main Analysis ──
const ver2 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 2 ORDER BY created_at DESC LIMIT 1').get()
const stages2 = JSON.parse(ver2.stages_json)

// Stage 1: Add emotion to output rules and JSON example
stages2[0].prompt = stages2[0].prompt
  .replace(
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer`,
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer
- "emotion": 1-2 sentences describing what the viewer is meant to FEEL during this chapter/beat — the emotional journey (e.g. curiosity, fear, relief, excitement, empathy, urgency)`
  )
  // Add emotion to chapter example
  .replace(
    `"purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "beats"`,
    `"purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "emotion": "Anxiety and dread — the viewer should feel personally threatened, like the ground is shifting under their feet.",
      "beats"`
  )
  // Add emotion to beat example
  .replace(
    `"purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention."`,
    `"purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention.",
          "emotion": "Shock and urgency — a gut punch that makes the viewer think 'this applies to ME'."`
  )

// Stage 6 (Pattern analysis): Add emotion to chapter header
stages2[5].prompt = stages2[5].prompt
  .replace(
    `**Purpose:** {{chapter_purpose}}
**Beats:**`,
    `**Purpose:** {{chapter_purpose}}
**Emotion:** {{chapter_emotion}}
**Beats:**`
  )

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages2), ver2.id)
console.log('Strategy 2 updated (stages 1, 6)')

// ── Strategy 3: Plan ──
const ver3 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 3 ORDER BY created_at DESC LIMIT 1').get()
const stages3 = JSON.parse(ver3.stages_json)

// Stage 4: Analyze Chapters & Beats — add emotion to output rules and example
stages3[3].prompt = stages3[3].prompt
  .replace(
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer`,
    `- "purpose": 1-2 sentences explaining WHY this chapter/beat exists in the video — what editorial or narrative function does it serve for the viewer
- "emotion": 1-2 sentences describing what the viewer is meant to FEEL during this chapter/beat — the emotional journey (e.g. curiosity, fear, relief, excitement, empathy, urgency)`
  )
  .replace(
    `"purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "beats"`,
    `"purpose": "Hook the audience with a stark, personal warning. Establishes the stakes so viewers feel the urgency before any solutions are offered.",
      "emotion": "Anxiety and dread — the viewer should feel personally threatened, like the ground is shifting under their feet.",
      "beats"`
  )
  .replace(
    `"purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention."`,
    `"purpose": "Create immediate urgency and personal stakes. Forces the viewer to stop scrolling and pay attention.",
          "emotion": "Shock and urgency — a gut punch that makes the viewer think 'this applies to ME'."`
  )

// Stage 6: Create B-Roll strategy — add emotion to chapter context
stages3[5].prompt = stages3[5].prompt
  .replace(
    `Purpose: {{chapter_purpose}}

A-Roll appearance`,
    `Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

A-Roll appearance`
  )

// Stage 7: Per-chapter B-Roll plan — add emotion to chapter context
stages3[6].prompt = stages3[6].prompt
  .replace(
    `Purpose: {{chapter_purpose}}

Beats:`,
    `Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

Beats:`
  )

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages3), ver3.id)
console.log('Strategy 3 updated (stages 4, 6, 7)')

// ── Strategy 4: Alt Plan ──
const ver4 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 4 ORDER BY created_at DESC LIMIT 1').get()
const stages4 = JSON.parse(ver4.stages_json)

// Stage 1: Create Alternative Strategy — add emotion to chapter context
stages4[0].prompt = stages4[0].prompt
  .replace(
    `Purpose: {{chapter_purpose}}

Beats:`,
    `Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

Beats:`
  )

// Stage 2: Per-chapter Alternative Plan — add emotion to chapter context
stages4[1].prompt = stages4[1].prompt
  .replace(
    `Purpose: {{chapter_purpose}}

Beats:`,
    `Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

Beats:`
  )

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages4), ver4.id)
console.log('Strategy 4 updated (stages 1, 2)')

console.log('\nDone — emotion field added to all strategies')
process.exit(0)
