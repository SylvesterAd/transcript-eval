import db from '../db.js'

const version = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 3 ORDER BY created_at DESC LIMIT 1').get()
const stages = JSON.parse(version.stages_json)

// Stage index 5 = UI "Stage 6" = Create B-Roll strategy (per_chapter)
stages[5].prompt = `You are creating a B-Roll strategy for ONE chapter of a new video. You must base it on a real reference video analysis.

## Step 1: Understand the reference video
Below is the full analysis of a reference video. Each chapter contains:
- frequency_and_timing: exact per_minute rates, usage splits, what_footage_looks_like, what_content_is_shown, why_its_used
- pattern_analysis: deep breakdown of commonalities, broll sources/types/purposes/style/rules, graphic_package purpose/format/style/rules, overlay_image purpose/positioning/style/rules, overall_rules

{{reference_analysis}}

## Step 2: Understand THIS chapter of the new video
Chapter {{chapter_number}}: "{{chapter_name}}"
Time: {{chapter_start_tc}} - {{chapter_end_tc}} ({{chapter_duration_seconds}} seconds)
Purpose: {{chapter_purpose}}

A-Roll appearance (your B-Roll style must complement this):
{{llm_answer_3}}

Beats:
{{chapter_beats}}

Transcript:
{{chapter_transcript}}

## Step 3: Match to the best reference chapter
Look at each reference chapter's PURPOSE and BEATS. Find the one that serves the most similar narrative role. For example:
- A "hook" chapter matches another "hook/emotional opening" chapter
- A "product reveal" chapter matches another "product showcase/offer" chapter
- A "social proof" chapter matches another "testimonial/evidence" chapter
- A "science explanation" chapter matches another "education/mechanism" chapter

## Step 4: Build the strategy
From your matched reference chapter's pattern_analysis, ADAPT the following to fit THIS chapter's content:
- Copy frequency targets exactly (per_minute, usage_split)
- Adapt the broll sources ratio, main types, type purposes, and style approach
- Adapt graphic package purpose/format/style if the reference uses them
- Adapt overlay image purpose/positioning/style
- Write chapter-specific overall editing rules
- MATCH A-ROLL STYLE: Look at the A-Roll appearance above (colors, lighting, temperature, wardrobe). Your style notes must complement it — similar color temperature, compatible tones, coherent visual feel.

Return JSON:
\`\`\`json
{
  "matched_reference_chapter": {
    "chapter_name": "The Dark Spot Epidemic and Margaret's Story",
    "chapter_number": 1,
    "match_reason": "Both chapters serve as emotional hooks — establishing a personal problem narrative to create empathy and urgency"
  },
  "frequency_targets": {
    "broll": { "target_per_minute": 13.6, "target_usage_pct": 94 },
    "graphic_package": { "target_per_minute": 0, "target_usage_pct": 0 },
    "overlay_image": { "target_per_minute": 0.8, "target_usage_pct": 6 }
  },
  "strategy": {
    "commonalities": "Describe the overall editing approach for this chapter — the pacing, visual arc, and how all elements work together to serve the chapter's purpose.",
    "broll": {
      "sources": "Explain which source feels to use and WHY this mix works for this chapter's content. E.g. 'Stock footage & cinematic (90%) because it enables rapid, high-production-value storytelling across diverse emotional states. Custom Graphic Animation (10%) for any microscopic/scientific claims.'",
      "main_types": ["Reaction / Expression", "Lifestyle / Scenario", "Human interaction", "Object / Detail insert"],
      "type_purposes": {
        "Reaction / Expression": "WHY this type is needed — what narrative job it does in this specific chapter",
        "Lifestyle / Scenario": "WHY — what moments or scenarios to show and what they accomplish",
        "Human interaction": "WHY — what relationships or dynamics to illustrate",
        "Object / Detail insert": "WHY — what objects or textures to highlight and what they prove"
      },
      "style_vs_aroll": "Describe how B-Roll should visually relate to the A-Roll. Color temperature shifts, lighting contrasts, how 'problem' beats look vs 'solution' beats, etc.",
      "rules": [
        "Specific, actionable editing rules for B-Roll in this chapter",
        "E.g. 'Maintain nearly continuous B-Roll with gaps under 1 second to keep the emotional hook fast-paced'",
        "E.g. 'Mirror the emotional state through lighting — cool/dark for the problem, warm/bright for the solution'",
        "E.g. 'Keep clip durations 3-5 seconds to match narration rhythm'"
      ]
    },
    "graphic_package": {
      "purpose": "When and why to use graphic packages in this chapter. If count is 0, explain WHY they are intentionally omitted.",
      "format": "Layout descriptions if used (e.g. 'Split-screen with speaker in 35% left box, data panel on right'). Or 'N/A' if omitted.",
      "style": "Visual style if used (colors, typography, background). Or 'N/A' if omitted.",
      "rules": [
        "When to deploy and when to avoid graphic packages",
        "E.g. 'Avoid graphic packages during the emotional opening — rely on cinematic B-Roll to maintain immersion'"
      ]
    },
    "overlay_image": {
      "purpose": "What overlays accomplish in this chapter — directing attention, labeling, symbolizing.",
      "positioning": "Where to place overlays and what they should anchor to.",
      "style": "Visual style — cutout types, icon styles, contrast approach.",
      "rules": [
        "When to trigger overlays and how long to show them",
        "E.g. 'Use sparingly to punctuate only the most critical visual evidence'",
        "E.g. 'Anchor directly to the physical object being discussed'"
      ]
    },
    "overall_rules": [
      "High-level editing rules that govern all elements in this chapter",
      "E.g. 'Hook the viewer by covering A-Roll almost entirely with rapid, emotionally driven cinematic stock footage'",
      "E.g. 'Create a stark visual contrast between agitation phase (moody, stressful) and solution phase (bright, confident)'",
      "E.g. 'Use B-Roll to tell a parallel relatable human story while narration delivers broader context'"
    ]
  }
}
\`\`\``

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), version.id)
console.log('Updated stage 6 (Create B-Roll strategy) with analysis-matching output structure')
