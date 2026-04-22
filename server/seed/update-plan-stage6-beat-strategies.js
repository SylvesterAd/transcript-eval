import db from '../db.js'

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 3 ORDER BY created_at DESC LIMIT 1').get()
const stages = JSON.parse(ver.stages_json)

// Replace Stage 6 (Create B-Roll strategy) prompt
stages[5].prompt = `You are creating a B-Roll strategy for ONE chapter of a new video. You must base it on a real reference video analysis.

## Step 1: Understand the reference video
Below is the full analysis of a reference video. Each chapter contains:
- frequency_and_timing: exact per_minute rates, usage splits, what_footage_looks_like, what_content_is_shown, why_its_used
- pattern_analysis: chapter-level breakdown (commonalities, broll sources/types/purposes/style/rules, graphic_package, overlay_image, overall_rules) AND per-beat b-roll strategies (beat_strategies) — each beat has emotion, strategy_points describing visual approaches with colors, style, motion, and emotional purpose

{{reference_analysis}}

## Step 2: Understand THIS chapter of the new video
Chapter {{chapter_number}}: "{{chapter_name}}"
Time: {{chapter_start_tc}} - {{chapter_end_tc}} ({{chapter_duration_seconds}} seconds)
Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

A-Roll appearance (your B-Roll style must complement this):
{{llm_answer_1}}

Beats:
{{chapter_beats}}

Transcript:
{{chapter_transcript}}

## Step 3: Match to the best reference chapter

Find the reference chapter that best matches THIS chapter. Compare using ALL of these:
1. **Chapter purpose & emotion** — which reference chapter serves the most similar narrative role AND targets the same viewer emotion?
2. **Beat-level similarity** — which reference chapter's beats have the most similar purposes and emotions to THIS chapter's beats? A chapter with 3 beats about "problem → proof → hope" matches another "problem → evidence → turning point" chapter better than a "product → pricing → guarantee" chapter, even if the chapter-level purpose seems similar.

Pick the chapter where BOTH the chapter emotion AND the beat emotions align best.

## Step 4: Build the chapter-level strategy

From your matched reference chapter's pattern_analysis, ADAPT the following to fit THIS chapter's content:
- Copy frequency targets exactly (per_minute, usage_split)
- Adapt the broll sources ratio, main types, type purposes, and style approach
- Adapt graphic package purpose/format/style if the reference uses them
- Adapt overlay image purpose/positioning/style
- Write chapter-specific overall editing rules
- MATCH A-ROLL STYLE: Look at the A-Roll appearance above (colors, lighting, temperature, wardrobe). Your style notes must complement it — similar color temperature, compatible tones, coherent visual feel.

## Step 5: Build per-beat strategies (CRITICAL)

This is the most important part. For each beat in THIS chapter:

1. Find the best-matching beat from the reference chapter's beat_strategies — match by beat PURPOSE and EMOTION, not by position
2. ADAPT that beat's strategy_points to fit THIS beat's content. Each strategy point must include:
   - WHAT to show and WHY (the editorial job)
   - COLORS and WHY those colors (what emotion they create)
   - STYLE/MOTION and WHY
   - How the style SHIFTS from the previous beat and what that shift accomplishes emotionally
3. If NO reference beat matches well, create strategy points from scratch using the chapter-level patterns
4. Typically 1-4 strategy points per beat — group by visual purpose, not individual clips

The beat strategies define the EMOTIONAL ARC of visual storytelling through the chapter. Each beat should feel intentionally different from the last when the emotion changes.

Return JSON:
\`\`\`json
{
  "matched_reference_chapter": {
    "chapter_name": "The Dark Spot Epidemic and Margaret's Story",
    "chapter_number": 1,
    "match_reason": "Both chapters serve as emotional hooks with similar beat structure: personal story → scale of problem → scientific turning point. The beat emotions align: empathy → shock → hope."
  },
  "frequency_targets": {
    "broll": { "target_per_minute": 13.6, "target_usage_pct": 94 },
    "graphic_package": { "target_per_minute": 0, "target_usage_pct": 0 },
    "overlay_image": { "target_per_minute": 0.8, "target_usage_pct": 6 }
  },
  "strategy": {
    "commonalities": "Describe the overall editing approach for this chapter — the pacing, visual arc, and how all elements work together to serve the chapter's purpose.",
    "broll": {
      "sources": "Explain which source feels to use and WHY this mix works for this chapter's content.",
      "main_types": ["Reaction / Expression", "Lifestyle / Scenario", "Human interaction", "Object / Detail insert"],
      "type_purposes": {
        "Reaction / Expression": "WHY this type is needed — what narrative job it does in this specific chapter",
        "Lifestyle / Scenario": "WHY — what moments or scenarios to show and what they accomplish"
      },
      "style_vs_aroll": "Describe how B-Roll should visually relate to the A-Roll. Color temperature shifts, lighting contrasts, how 'problem' beats look vs 'solution' beats, etc.",
      "rules": [
        "Specific, actionable editing rules for B-Roll in this chapter"
      ]
    },
    "graphic_package": {
      "purpose": "When and why to use graphic packages in this chapter. If count is 0, explain WHY they are intentionally omitted.",
      "format": "Layout descriptions if used. Or 'N/A' if omitted.",
      "style": "Visual style if used. Or 'N/A' if omitted.",
      "rules": ["When to deploy and when to avoid graphic packages"]
    },
    "overlay_image": {
      "purpose": "What overlays accomplish in this chapter.",
      "positioning": "Where to place overlays and what they should anchor to.",
      "style": "Visual style — cutout types, icon styles, contrast approach.",
      "rules": ["When to trigger overlays and how long to show them"]
    },
    "overall_rules": [
      "High-level editing rules that govern all elements in this chapter"
    ]
  },
  "beat_strategies": [
    {
      "beat_name": "The Opening Hook",
      "beat_emotion": "Anxiety and personal threat",
      "matched_reference_beat": "Margaret's Devastating Discovery",
      "match_reason": "Both beats establish personal emotional pain to hook the viewer",
      "strategy_points": [
        "Emotional close-ups of worried faces and mirror reflections — warm but desaturated tones to show dissatisfaction. Slow intimate motion. Builds personal connection by making the viewer SEE the pain.",
        "Clinical detail shots proving the problem is real — cool whites and blues under harsh lighting. Static or slow zoom. Shifts from emotional to evidence-based, creating a 'this is medical, not vanity' feeling."
      ]
    },
    {
      "beat_name": "The Scale Reveal",
      "beat_emotion": "Shock at how widespread this is",
      "matched_reference_beat": "The Hidden Epidemic",
      "match_reason": "Both beats expand from personal story to widespread problem",
      "strategy_points": [
        "Rapid montage of diverse faces showing concern — warm skin tones, cool backgrounds, quick 2-3 second cuts. Volume of faces = scale of problem. Sharp pacing shift from the intimate previous beat.",
        "Document and chart proof shots — clean whites, neutral backgrounds. Static. Color shift from warm faces to cool data signals 'here are the facts'. Builds trust through objectivity."
      ]
    }
  ]
}
\`\`\``

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)
console.log('Plan Stage 6 updated with beat_strategies + improved chapter matching')

// Also update alt plan Stage 1 (Create Alternative Strategy) — same structure
const ver4 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = 4 ORDER BY created_at DESC LIMIT 1').get()
const stages4 = JSON.parse(ver4.stages_json)

// Update the matching instruction in alt plan Stage 1
stages4[0].prompt = stages4[0].prompt
  .replace(
    `### Step 1: Find the best matching chapter
Look at each chapter in the alternative reference analysis. Find the one whose PURPOSE and BEATS most closely match this chapter's narrative role.`,
    `### Step 1: Find the best matching chapter
Look at each chapter in the alternative reference analysis. Find the one that best matches by:
1. Chapter PURPOSE and EMOTION — similar narrative role AND target viewer emotion
2. Beat-level similarity — compare beat purposes and emotions, not just chapter-level

Pick the chapter where BOTH the chapter emotion AND the beat emotions align best.`
  )

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages4), ver4.id)
console.log('Alt Plan Stage 1 matching updated')

process.exit(0)
