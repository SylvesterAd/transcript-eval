import db from '../db.js'

const categoryDefinitions = `# Main Categories:
A-roll: Primary footage that carries the narrative (often a talking head/interview).
Callout Text: On-screen text added to emphasize, label, or summarize information (not a transcript).
Overlay images: Non-text visual elements layered on top of the base visual to illustrate, reinforce, or direct attention. Overlay images can appear on A-roll only!
Graphic package / PiP: A layout template that defines the base visual (background + frames + placement). It usually contains A-roll inside a box, plus branded design elements.
B-roll: Supporting footage used to illustrate the narration or cover A-roll.

# IGNORE SUBTITLES
Subtitles = on-screen text that matches what is being said. Ignore them completely.`

const enumDefinitions = `# Enum Values (use ONLY these exact strings):
## function: "Inform - Illustrate" | "Inform - Clarify" | "Inform - Explain process" | "Proof - Validate claim" | "Proof - Showcase result" | "Product - Showcase product" | "Product - Showcase feature" | "Product - Demonstrate use" | "Story - Set mood" | "Story - Symbolize idea" | "Editing/Pacing - Mask cut" | "Editing/Pacing - Pattern-break" | "Editing/Pacing - Pause / breathe"
## type_group: "Product / UI showcase" | "Product-in-use" | "UI flow / Screen recording" | "Document / Media proof" | "TV News" | "Cut from TV show" | "TikTok / YouTube video" | "Social Media Post" | "Meme" | "Film / TV Series clip" | "Statistical graphic" | "Text highlight" | "Hands-at-work" | "Process / Step-by-step action" | "Human interaction" | "Reaction / Expression" | "Famous Person Portrait" | "Environment / Establishing" | "Mood environment" | "Object / Detail insert" | "Brand element" | "Before / After contrast" | "Lifestyle / Scenario" | "Location-specific reference" | "Symbolic / Metaphorical" | "Motion / Travel shot" | "Time-passage" | "Archived / Historical" | "Graphic / Motion design"
`

const stages = [
  // ── Stage 1: Per-chapter alternative B-Roll plan ──
  {
    name: 'Per-chapter alternative plan',
    type: 'transcript_question',
    target: 'text_only',
    model: 'gemini-3.1-pro-preview',
    per_chapter: true,
    system_instruction: `${categoryDefinitions}

${enumDefinitions}

You are a senior video editor creating an ALTERNATIVE B-Roll plan. You have:
1. The FAVORITE plan with exact timecodes and placements (these timecodes MUST be preserved exactly)
2. An ALTERNATIVE reference video's analysis with different patterns and style

Your job: create new placements that use the alternative reference style BUT keep the EXACT SAME timecodes as the favorite plan. Same "when", different "what".

Output ONLY valid JSON.`,
    prompt: `Create an alternative B-Roll plan for chapter {{chapter_number}} of {{total_chapters}}.

## ── CHAPTER ──
### "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
**Purpose:** {{chapter_purpose}}
**Beats:**
{{chapter_beats}}

## ── FAVORITE PLAN (keep these EXACT timecodes) ──
{{favorite_plan}}

## ── ALTERNATIVE REFERENCE VIDEO ANALYSIS (use these patterns/style) ──
{{reference_analysis}}

## ── CHAPTER TRANSCRIPT ──
{{chapter_transcript}}

## ── RULES ──
1. Keep the EXACT same start_tc, end_tc, start_seconds, end_seconds for each placement
2. Keep the same audio_anchor (it's tied to the transcript)
3. CHANGE: category, description, search_keywords, type_group, style, layout, function, trigger
4. Base the new choices on the ALTERNATIVE reference video's patterns and style
5. The result should feel like "same video, different visual style inspiration"

Return JSON with the same structure as the favorite plan but with alternative content:
\`\`\`json
{
  "chapter_name": "{{chapter_name}}",
  "chapter_number": {{chapter_number}},
  "alternative_source": "Name of alternative reference video",
  "placements": [
    {
      "start_seconds": 1,
      "end_seconds": 3,
      "start_tc": "[00:00:01]",
      "end_tc": "[00:00:03]",
      "category": "broll",
      "audio_anchor": "same as favorite",
      "function": "may differ based on alt reference patterns",
      "trigger": "may differ",
      "type_group": "based on alt reference patterns",
      "description": "New description inspired by alternative reference style",
      "search_keywords": ["new", "keywords"],
      "style": { "colors": "from alt reference", "temperature": "from alt", "motion": "from alt" },
      "priority": "high"
    }
  ]
}
\`\`\``,
    params: { temperature: 1, thinking_level: 'HIGH' },
  },

  // ── Stage 2: Assemble alternative plan ──
  {
    name: 'Assemble alternative plan',
    type: 'programmatic',
    target: 'text_only',
    action: 'assemble_broll_plan',
    actionParams: {},
    description: 'Merge per-chapter alternative B-Roll plans into one document',
  },
]

// Find plan strategy to link
const planStrategy = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'plan' ORDER BY id LIMIT 1").get()
const planId = planStrategy?.id || null

// Upsert
let existing = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'alt_plan' AND name = 'Alternative B-Roll Plan' LIMIT 1").get()
let stratId
if (existing) {
  stratId = existing.id
  await db.prepare("UPDATE broll_strategies SET description = $1, main_strategy_id = $2 WHERE id = $3").run(
    '2-step: per-chapter alternative plan using different reference style but same timecodes, assemble',
    planId, stratId
  )
  console.log('Alt plan strategy updated:', stratId)
} else {
  const strat = await db.prepare(`
    INSERT INTO broll_strategies (name, description, strategy_kind, main_strategy_id, analysis_model)
    VALUES ($1, $2, $3, $4, $5)
  `).run(
    'Alternative B-Roll Plan',
    '2-step: per-chapter alternative plan using different reference style but same timecodes, assemble',
    'alt_plan', planId, 'gemini-3.1-pro-preview'
  )
  stratId = strat.lastInsertRowid
  console.log('Alt plan strategy created:', stratId)
}
console.log(planId ? `Linked to plan strategy ${planId}` : 'No plan strategy found')

// Upsert version
const existingVer = await db.prepare("SELECT id FROM broll_strategy_versions WHERE strategy_id = ? AND name = 'Version 1' LIMIT 1").get(stratId)
let ver
if (existingVer) {
  await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?')
    .run(JSON.stringify(stages), existingVer.id)
  ver = { lastInsertRowid: existingVer.id }
} else {
  ver = await db.prepare(`
    INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
    VALUES ($1, $2, $3, $4)
  `).run(stratId, 'Version 1', 'Alternative B-Roll plan: same timecodes, different style', JSON.stringify(stages))
}

console.log('Version:', ver.lastInsertRowid)
console.log('2 stages:')
console.log('  1. Per-chapter alternative plan (per_chapter, uses favorite timecodes + alt analysis)')
console.log('  2. Assemble alternative plan (programmatic)')
process.exit(0)
