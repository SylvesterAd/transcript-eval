import db from '../db.js'

// Check if already exists
const existing = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy'").get()
if (existing) {
  console.log('create_combined_strategy already exists (id=' + existing.id + '), updating version...')
}

const stages = [
  // Stage 1: Select best-matching beats from all references
  {
    name: 'Select best beats from all references',
    type: 'transcript_question',
    target: 'text_only',
    per_chapter: true,
    model: 'gemini-3.1-pro-preview',
    system_instruction: 'You are a senior video editor selecting the best B-Roll approaches from multiple reference videos. Your goal is to find the best visual strategy for each beat by comparing across ALL available references. Output ONLY valid JSON.',
    prompt: `You are selecting the best B-Roll beat strategies from multiple reference videos for ONE chapter of a new video.

## YOUR NEW VIDEO — CHAPTER {{chapter_number}}/{{total_chapters}}
**Chapter:** "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
**Purpose:** {{chapter_purpose}}
**Emotion:** {{chapter_emotion}}

**Beats:**
{{chapter_beats}}

**Chapter transcript:**
{{chapter_transcript}}

## FULL VIDEO TRANSCRIPT (for broader context)
{{transcript}}

## ALL REFERENCE VIDEO ANALYSES
Each reference contains chapters with beats, and each chapter has a pattern_analysis with beat_strategies — per-beat visual approaches with emotion, colors, style, and strategy_points.

{{all_reference_analyses}}

## INSTRUCTIONS

For each beat in YOUR chapter above:

1. **Scan ALL references' beat_strategies** across ALL their chapters (not just matching chapters)
2. **Match by beat PURPOSE and EMOTION first** — find the reference beat whose editorial purpose and target emotion best fits your beat
3. **Consider the strategy_points quality** — which reference beat's strategy_points would best serve your beat's content?
4. **Chapter-level match is secondary** — a beat from a different chapter type in a reference can be the best match if the beat-level purpose/emotion aligns

For each beat selection, include:
- Which reference and which beat you're selecting from
- The reference beat's full context (description, purpose, emotion)
- ALL strategy_points from that reference beat (copy them exactly)
- WHY this is the best match (what makes it better than alternatives from other references)

Return JSON:
\`\`\`json
{
  "chapter_name": "{{chapter_name}}",
  "beat_selections": [
    {
      "new_video_beat": "The Opening Hook",
      "new_video_beat_purpose": "Hook the viewer with a shocking claim",
      "new_video_beat_emotion": "Shock and urgency",
      "selected_from_reference": "Crunchy Brain Syndrome",
      "selected_reference_chapter": "The Mystery of Mark and the Restart Button",
      "selected_reference_beat": "The Amazing Memory Man",
      "reference_beat_description": "Introduces 63-year-old Mark known for his 100% accurate memory",
      "reference_beat_purpose": "Establishes a compelling case study to hook the audience",
      "reference_beat_emotion": "Awe and curiosity",
      "reference_beat_strategy_points": [
        "Validation and Proof: Close-up shots of newspaper clippings...",
        "Everyday Lifestyle Contrast: Wide and medium shots..."
      ],
      "match_reason": "Both beats serve as hooks through extraordinary personal stories. The reference beat's strategy of combining proof shots with relatable lifestyle creates the same 'wow but real' feeling needed for our hook.",
      "alternatives_considered": "Reference B's hook beat used fear-based dark imagery — wrong emotion for our curiosity-driven opening"
    }
  ]
}
\`\`\``,
    params: { temperature: 0.3, thinking_level: 'HIGH' },
  },

  // Stage 2: Create combined strategy from selected beats
  {
    name: 'Create combined B-Roll strategy',
    type: 'transcript_question',
    target: 'text_only',
    per_chapter: true,
    model: 'gemini-3.1-pro-preview',
    system_instruction: `You are a senior video editor creating a B-Roll strategy by adapting cherry-picked beat strategies from multiple reference videos into a cohesive plan. Output ONLY valid JSON.`,
    prompt: `Create a B-Roll strategy for ONE chapter by adapting the best beat strategies selected from multiple reference videos.

## THIS CHAPTER
Chapter {{chapter_number}}/{{total_chapters}}: "{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

A-Roll appearance (your B-Roll style must complement this):
{{llm_answer_1}}

Beats:
{{chapter_beats}}

Transcript:
{{chapter_transcript}}

## BEAT SELECTIONS (from previous step)
These are the best-matching reference beats selected for each of your beats, with their strategy_points:

{{prev_chapter_output}}

## ALL REFERENCE ANALYSES (for frequency/timing context)
{{all_reference_analyses}}

## INSTRUCTIONS

### Step 1: Determine frequency targets
Look at the matched reference chapters' frequency_and_timing data. Average the per_minute rates across the references that contributed beats to create balanced frequency targets.

### Step 2: Build chapter-level strategy
From the selected beats' strategy_points, build a cohesive chapter-level strategy:
- Merge similar approaches across beats (e.g., if 2 beats both use "cinematic stock", that's one source rule)
- Identify the overall color arc and style progression
- Write chapter-wide rules

### Step 3: Build per-beat strategies (CRITICAL)
For each beat, ADAPT the selected reference beat's strategy_points to fit YOUR beat's specific content:
- Keep the visual approach and emotional intent from the reference
- Change the specific descriptions to match YOUR beat's transcript content
- Ensure style TRANSITIONS between beats feel cohesive even though they come from different references
- If two adjacent beats come from very different reference styles, explain how to bridge them

### Step 4: MATCH A-ROLL STYLE
Look at the A-Roll appearance above. All B-Roll style notes must complement it — similar color temperature, compatible tones, coherent visual feel.

Return JSON (same format as single-reference strategies):
\`\`\`json
{
  "matched_references": [
    { "reference_name": "Crunchy Brain Syndrome", "beats_used": 2 },
    { "reference_name": "Dark Spot Video", "beats_used": 1 }
  ],
  "frequency_targets": {
    "broll": { "target_per_minute": 11.0, "target_usage_pct": 90 },
    "graphic_package": { "target_per_minute": 0.5, "target_usage_pct": 5 },
    "overlay_image": { "target_per_minute": 0.5, "target_usage_pct": 5 }
  },
  "strategy": {
    "commonalities": "Overall editing approach — how the cherry-picked beats work together as a cohesive chapter",
    "broll": {
      "sources": "Combined source mix from selected beats",
      "main_types": ["..."],
      "type_purposes": {"type": "purpose"},
      "style_vs_aroll": "How B-Roll relates to A-Roll across the beat transitions",
      "rules": ["Chapter-wide B-Roll rules synthesized from all selected beats"]
    },
    "graphic_package": { "purpose": "...", "format": "...", "style": "...", "rules": ["..."] },
    "overlay_image": { "purpose": "...", "positioning": "...", "style": "...", "rules": ["..."] },
    "overall_rules": ["High-level rules governing the chapter"]
  },
  "beat_strategies": [
    {
      "beat_name": "The Opening Hook",
      "beat_emotion": "Shock and urgency",
      "selected_from": "Crunchy Brain Syndrome / The Amazing Memory Man",
      "strategy_points": [
        "Adapted strategy point 1 — specific to THIS beat's content...",
        "Adapted strategy point 2..."
      ]
    }
  ]
}
\`\`\``,
    params: { temperature: 0.3, thinking_level: 'HIGH' },
  },
]

let strategyId
if (existing) {
  strategyId = existing.id
  await db.prepare('UPDATE broll_strategies SET name = ?, description = ? WHERE id = ?').run(
    'Combined Best-of-All Strategy',
    'Cherry-pick the best beat strategies from ALL reference videos. Step 1: Select best-matching beats across all references. Step 2: Create cohesive combined strategy.',
    strategyId
  )
} else {
  const result = await db.prepare(`
    INSERT INTO broll_strategies (name, description, strategy_kind)
    VALUES ($1, $2, $3)
  `).run(
    'Combined Best-of-All Strategy',
    'Cherry-pick the best beat strategies from ALL reference videos. Step 1: Select best-matching beats across all references. Step 2: Create cohesive combined strategy.',
    'create_combined_strategy'
  )
  strategyId = result.lastInsertRowid
}

await db.prepare(`
  INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
  VALUES ($1, $2, $3, $4)
`).run(strategyId, 'Version 1', '2-stage: beat selection + combined strategy creation', JSON.stringify(stages))

console.log(`Created create_combined_strategy (id=${strategyId})`)
console.log('  Stage 1: Select best beats from all references (per_chapter)')
console.log('  Stage 2: Create combined B-Roll strategy (per_chapter)')
process.exit(0)
