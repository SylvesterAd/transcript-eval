import db from '../db.js'

// Find the create_strategy strategy (should be id=8, but use strategy_kind to be safe)
const strategy = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1").get()
if (!strategy) { console.error('No create_strategy strategy found'); process.exit(1) }

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy.id)
if (!ver) { console.error('No version found'); process.exit(1) }

const stages = JSON.parse(ver.stages_json)

// Find the per_chapter stage (the main strategy creation stage)
const stageIdx = stages.findIndex(s => s.per_chapter)
if (stageIdx === -1) { console.error('No per_chapter stage found'); process.exit(1) }

console.log(`Updating strategy ${strategy.id}, version ${ver.id}, stage ${stageIdx} ("${stages[stageIdx].name}")`)
console.log('Change: Beat matching is now PRIMARY, chapter matching is SECONDARY')

stages[stageIdx].prompt = `You are creating a B-Roll strategy for ONE chapter of a new video. You must base it on a real reference video analysis.

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

## Step 3: Match beats FIRST (PRIMARY matching criterion)

For each beat in THIS chapter, scan ALL reference chapters' beat_strategies — not just the best-matching chapter. Find the reference beat whose editorial approach best fits.

Match by:
1. **Beat PURPOSE and EMOTION first** — find the reference beat whose editorial purpose and target emotion best fits your beat. A "hook with shock" beat matches another "hook with urgency" beat better than a "conclusion with reflection" beat, regardless of which chapter it's in.
2. **Strategy_points quality** — which reference beat's strategy_points would best serve your beat's content? Look at the visual approach, colors, style, and emotional arc.
3. **Chapter-level match is secondary** — a beat from a different chapter type in the reference can be the best match if the beat-level purpose/emotion aligns. Don't restrict yourself to one reference chapter.

## Step 4: Determine the best-matching reference chapter (SECONDARY)

After matching all beats, look at which reference chapter contributed the most beat matches. Use that chapter's frequency_and_timing and pattern_analysis as the baseline for chapter-level strategy. If beats came from multiple chapters, blend the frequency targets.

From the dominant reference chapter's pattern_analysis, ADAPT the following:
- Copy frequency targets (per_minute, usage_split) — average if beats came from multiple chapters
- Adapt the broll sources ratio, main types, type purposes, and style approach
- Adapt graphic package purpose/format/style if the reference uses them
- Adapt overlay image purpose/positioning/style
- Write chapter-specific overall editing rules
- MATCH A-ROLL STYLE: Look at the A-Roll appearance above (colors, lighting, temperature, wardrobe). Your style notes must complement it — similar color temperature, compatible tones, coherent visual feel.

## Step 5: Build per-beat strategies (CRITICAL)

{{prior_chapter_strategies}}

If prior strategies for this chapter are shown above, your strategy MUST be meaningfully different. Do not produce the same or a similar approach. Choose different visual angles, different beat strategies, different style/motion choices. The goal is genuine variety across reference videos — not minor re-wordings.

This is the most important part. For each beat in THIS chapter:

1. Use the best-matching reference beat you found in Step 3 — it can be from ANY reference chapter
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
    "match_reason": "Most beats matched from this chapter. Beats 1 and 3 matched directly. Beat 2 came from Chapter 3 ('The Scientific Breakthrough') because its proof-oriented emotion was a better fit."
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
      "matched_from_chapter": "The Dark Spot Epidemic and Margaret's Story",
      "matched_from_chapter_number": 1,
      "match_reason": "Both beats establish personal emotional pain to hook the viewer — purpose and emotion align perfectly",
      "strategy_points": [
        "Emotional close-ups of worried faces and mirror reflections — warm but desaturated tones to show dissatisfaction. Slow intimate motion. Builds personal connection by making the viewer SEE the pain.",
        "Clinical detail shots proving the problem is real — cool whites and blues under harsh lighting. Static or slow zoom. Shifts from emotional to evidence-based, creating a 'this is medical, not vanity' feeling."
      ]
    },
    {
      "beat_name": "The Scale Reveal",
      "beat_emotion": "Shock at how widespread this is",
      "matched_reference_beat": "The Scientific Proof",
      "matched_from_chapter": "The Scientific Breakthrough",
      "matched_from_chapter_number": 3,
      "match_reason": "This beat from Chapter 3 has a stronger proof-and-scale emotion than the Chapter 1 equivalent — better fit for our 'shock at scale' beat",
      "strategy_points": [
        "Rapid montage of diverse faces showing concern — warm skin tones, cool backgrounds, quick 2-3 second cuts. Volume of faces = scale of problem.",
        "Document and chart proof shots — clean whites, neutral backgrounds. Static. Color shift from warm faces to cool data signals 'here are the facts'."
      ]
    }
  ]
}
\`\`\``

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)
console.log(`Done — create_strategy (id=${strategy.id}) updated:`)
console.log('  Step 3: Match beats FIRST (primary) across ALL reference chapters')
console.log('  Step 4: Determine best-matching chapter (secondary, from beat matches)')
console.log('  Step 5: Build per-beat strategies using cross-chapter matches')
console.log('  JSON: beat_strategies now include matched_from_chapter + matched_from_chapter_number')
process.exit(0)
