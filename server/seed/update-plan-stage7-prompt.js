import db from '../db.js'

const version = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 3 ORDER BY created_at DESC LIMIT 1').get()
const stages = JSON.parse(version.stages_json)

// Stage index 6 = UI "Stage 7" = Per-chapter B-Roll plan
stages[6].prompt = `Create exact B-Roll / Graphic Package / Overlay placements for this chapter.

## ── THIS CHAPTER ──
"{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
Purpose: {{chapter_purpose}}

Beats:
{{chapter_beats}}

## ── CHAPTER TRANSCRIPT (use these timecodes for your placements) ──
{{chapter_transcript}}

## ── B-ROLL STRATEGY FOR THIS CHAPTER (you MUST follow this) ──
{{llm_answer_5}}

## ── FULL VIDEO CONTEXT (all chapters for continuity) ──
{{all_chapters}}

## ── INSTRUCTIONS ──

You have the B-Roll strategy above — it contains:
- frequency_targets: exact per_minute and usage_pct for broll, graphic_package, overlay_image
- commonalities: the overall editing approach
- broll: sources, main_types, type_purposes, style_vs_aroll, rules
- graphic_package: purpose, format, style, rules
- overlay_image: purpose, positioning, style, rules
- overall_rules

Your job is to create SPECIFIC placements that execute this strategy. Follow these hard rules:

### FREQUENCY (non-negotiable):
- Calculate the EXACT number of placements needed: target_per_minute × (chapter_duration_seconds / 60)
- For B-Roll: if target is 13.6/min and chapter is 500s → you need ~113 B-Roll placements
- For Graphic Package: if target is 0/min → zero graphic packages
- For Overlay: if target is 0.8/min and chapter is 500s → you need ~7 overlays
- The usage_pct split MUST match: if strategy says 94% broll / 0% GP / 6% overlay, your counts must reflect that ratio
- DO NOT create more or fewer placements than the frequency demands

### PLACEMENT RULES:
- Every placement MUST have start/end timecodes from the transcript — real timestamps, not made up
- Every placement MUST have an audio_anchor — the exact phrase being spoken at that moment
- Follow the strategy's broll.rules, graphic_package.rules, overlay_image.rules exactly
- Follow the style_vs_aroll guidance for visual style
- Each description must be specific to the content being discussed — never generic

### TIMECODE FORMAT:
- Use ONLY [HH:MM:SS] format for all timecodes
- Do NOT include separate _seconds fields

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
      "function": "Proof - Validate claim",
      "trigger": "When she mentions reading something shocking",
      "type_group": "Document / Media proof",
      "source_feel": "Stock footage & cinematic",
      "description": "Close-up of a newspaper featuring the headline with yellow-highlighted text for emphasis",
      "search_keywords": ["newspaper headline", "shocking document", "highlighted text"],
      "style": {
        "colors": "black, white, yellow highlight",
        "temperature": "cool",
        "motion": "slow pan"
      }
    },
    {
      "start": "[00:00:17]",
      "end": "[00:00:22]",
      "category": "graphic_package",
      "audio_anchor": "there are three key steps",
      "function": "Inform - Clarify",
      "trigger": "When presenting multi-part information",
      "layout": "Speaker in 35% left box, steps panel on right (65%) over dark background with accent color highlighting active step",
      "style": "Clean, dark background, white text, brand accent color for active item"
    },
    {
      "start": "[00:00:11]",
      "end": "[00:00:13]",
      "category": "overlay_image",
      "audio_anchor": "in the next three years",
      "function": "Inform - Clarify",
      "trigger": "When speaker says three years",
      "description": "Bold text element '36 MONTHS' in high-contrast style",
      "position": "Center-right, anchored above speaker's hand"
    }
  ]
}
\`\`\``

// Also fix: llm_answer reference — strategy is now stage 5 (per_chapter), so its output
// is in the per-chapter llm answer slot. The {{llm_answer_5}} should reference the strategy output.
// But wait — with per_chapter stages, the questionCount increments per stage, not per chapter.
// Stage 2 (A-Roll) = llm_answer_3, Stage 3 (Chapters) = llm_answer_4, Stage 5 (Strategy per-ch) = llm_answer_5
// Stage 6 (this one) needs {{llm_answer_5}} for the strategy output. Let me verify this is correct.

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), version.id)
console.log('Updated stage 7 (Per-chapter B-Roll plan) prompt')
