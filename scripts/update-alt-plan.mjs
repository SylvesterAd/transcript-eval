import { readFileSync } from 'fs'

process.loadEnvFile('.env')
const db = (await import('../server/db.js')).default

// 1. Update plan strategy (ID 3) stage 7 to include strategyStageIndex
const planV = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = 3 ORDER BY created_at DESC LIMIT 1').get()
const planStages = JSON.parse(planV.stages_json)
console.log('Plan stage 7 before:', planStages[7].name, JSON.stringify(planStages[7].actionParams))
planStages[7].actionParams = { ...planStages[7].actionParams, strategyStageIndex: 5 }
console.log('Plan stage 7 after:', JSON.stringify(planStages[7].actionParams))
await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(planStages), planV.id)
console.log('Plan strategy updated')

// 2. Rewrite alt_plan strategy (ID 4)
const altV = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = 4 ORDER BY created_at DESC LIMIT 1').get()

const stage0Prompt = `You are creating an ALTERNATIVE B-Roll strategy for one chapter. You have TWO inputs:
1. The favorite plan's strategy for this chapter (what was chosen)
2. A different reference video's analysis (your inspiration for the alternative)

## ── THIS CHAPTER ──
Chapter {{chapter_number}}/{{total_chapters}}: "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
Purpose: {{chapter_purpose}}

Beats:
{{chapter_beats}}

## ── FAVORITE STRATEGY FOR THIS CHAPTER ──
Find chapter {{chapter_number}} ("{{chapter_name}}") in the favorite plan below and look at its "strategy" field:

{{favorite_plan}}

## ── ALTERNATIVE REFERENCE VIDEO ANALYSIS ──
Below is the full analysis of a DIFFERENT reference video. Use this as your style inspiration:

{{reference_analysis}}

## ── INSTRUCTIONS ──

### Step 1: Find the best matching chapter
Look at each chapter in the alternative reference analysis. Find the one whose PURPOSE and BEATS most closely match this chapter's narrative role.

### Step 2: Create an alternative strategy
Using the matched reference chapter's patterns, create a NEW strategy that DIFFERS from the favorite:
- Use different frequency targets (adapted from the alt reference chapter)
- Use different source feels / type groups / visual styles
- Use different rules that reflect the alt reference's editing approach
- The strategy should be a genuinely different creative direction, not a minor tweak

### Step 3: Explain the difference
Include a brief comparison: what the favorite does vs what this alternative does and why.

Return JSON (same format as the favorite strategy):
\`\`\`json
{
  "matched_reference_chapter": {
    "chapter_name": "...",
    "chapter_number": 1,
    "match_reason": "..."
  },
  "vs_favorite": "The favorite uses stock footage and cinematic B-Roll at 13/min. This alternative uses documentary-style footage at 8/min with more graphic packages, inspired by the reference video's educational approach.",
  "frequency_targets": {
    "broll": { "target_per_minute": 8.0, "target_usage_pct": 75 },
    "graphic_package": { "target_per_minute": 1.5, "target_usage_pct": 15 },
    "overlay_image": { "target_per_minute": 1.0, "target_usage_pct": 10 }
  },
  "strategy": {
    "commonalities": "...",
    "broll": { "sources": "...", "main_types": ["..."], "type_purposes": {}, "style_vs_aroll": "...", "rules": ["..."] },
    "graphic_package": { "purpose": "...", "format": "...", "style": "...", "rules": ["..."] },
    "overlay_image": { "purpose": "...", "positioning": "...", "style": "...", "rules": ["..."] },
    "overall_rules": ["..."]
  }
}
\`\`\``

const stage1Prompt = `Create ALTERNATIVE B-Roll placements for this chapter using the alternative strategy.

## ── THIS CHAPTER ──
Chapter {{chapter_number}}/{{total_chapters}}: "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
Purpose: {{chapter_purpose}}

Beats:
{{chapter_beats}}

## ── CHAPTER TRANSCRIPT (use these timecodes for your placements) ──
{{chapter_transcript}}

## ── ALTERNATIVE B-ROLL STRATEGY (you MUST follow this) ──
{{prev_chapter_output}}

## ── FAVORITE PLAN PLACEMENTS (your timing reference) ──
Find chapter {{chapter_number}} ("{{chapter_name}}") in the favorite plan below and look at its "plan" field for the timecodes and audio_anchors:

{{favorite_plan}}

## ── HARD RULES ──

### TIMING (non-negotiable):
- You MUST use the EXACT SAME start and end timecodes as the favorite plan's placements for this chapter
- You MUST use the EXACT SAME audio_anchor text as the favorite plan
- The number of placements SHOULD match the alternative strategy's frequency targets (you may add or remove placements compared to the favorite to match the new frequency)
- If adding new placements: use real timecodes from the transcript
- If removing placements: drop the least important ones to match the lower frequency target

### WHAT TO CHANGE:
- category (broll/graphic_package/overlay_image) — follow alt strategy's usage split
- description — completely new visuals inspired by the alt strategy's style
- function, trigger, type_group, source_feel — follow alt strategy
- style (colors, temperature, motion) — follow alt strategy's style_vs_aroll
- ONE B-Roll = ONE scene (no transitions within a single placement)

### WHAT TO KEEP:
- start/end timecodes (from favorite plan)
- audio_anchor text (from favorite plan)

### TIMECODE FORMAT:
- Use ONLY [HH:MM:SS] format

Return JSON:
\`\`\`json
{
  "total_placements": 120,
  "placements": [
    {
      "start": "[00:00:01]",
      "end": "[00:00:04]",
      "category": "broll",
      "audio_anchor": "stopped me cold",
      "function": "...",
      "trigger": "...",
      "type_group": "...",
      "source_feel": "...",
      "description": "...",
      "style": { "colors": "...", "temperature": "...", "motion": "..." }
    }
  ]
}
\`\`\``

const altStages = [
  {
    name: 'Create Alternative B-Roll Strategy',
    type: 'transcript_question',
    per_chapter: true,
    model: 'gemini-3.1-pro-preview',
    target: 'text_only',
    params: { temperature: 0.3 },
    prompt: stage0Prompt,
    system_instruction: 'You are a senior video editor creating an alternative creative direction. Output ONLY valid JSON. No commentary.'
  },
  {
    name: 'Per-chapter Alternative B-Roll Plan',
    type: 'transcript_question',
    per_chapter: true,
    model: 'gemini-3.1-pro-preview',
    target: 'text_only',
    params: { temperature: 0.3 },
    prompt: stage1Prompt,
    system_instruction: 'You are a senior video editor creating an alternative B-Roll plan. You follow the alternative strategy exactly while preserving the favorite plan\'s timing structure. Output ONLY valid JSON. No commentary.'
  },
  {
    name: 'Assemble alternative plan',
    type: 'programmatic',
    action: 'assemble_broll_plan',
    actionParams: {}
  }
]

console.log('Alt plan stages:', altStages.map(s => s.name))
await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(altStages), altV.id)
console.log('Alt plan strategy updated (version ' + altV.id + ')')
process.exit(0)
