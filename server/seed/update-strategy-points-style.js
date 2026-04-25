import db from '../db.js'

// ── The strategy point instructions we want (same approach as Pattern Analysis) ──
const beatStrategyInstructions = `For each beat in THIS chapter, look at the matched reference beat's strategy_points. A strategy point describes a VISUAL PURPOSE — what editorial job a group of b-rolls shares and what they look like.

### How to write strategy points:
1. Take the matched reference beat's strategy_points as your starting template
2. ADAPT them to fit THIS beat's transcript content — change the specific subjects and scenarios but keep the visual approach
3. Each strategy point should be a flowing description that naturally weaves together what's shown, colors, style/motion, and emotional purpose — all in one paragraph
4. If the colors or style SHIFT from the previous beat, weave that transition into the description

### What NOT to do:
- Do NOT structure strategy points as bullet sub-items (no "WHAT:", "COLORS:", "STYLE:" breakdowns)
- Do NOT use generic descriptions — anchor to THIS beat's specific content
- Do NOT describe more than 5 strategy points per beat — merge similar approaches

### How many strategy points?
Each distinct visual purpose = one strategy point. Typically 1-4 per beat.`

const beatStrategyExamples = `[
    {
      "beat_name": "The Opening Hook",
      "beat_emotion": "Anxiety and personal threat",
      "matched_reference_beat": "Margaret's Devastating Discovery",
      "matched_from_chapter": "The Dark Spot Epidemic and Margaret's Story",
      "matched_from_chapter_number": 1,
      "match_reason": "Both beats establish personal emotional pain to hook the viewer — purpose and emotion align perfectly",
      "strategy_points": [
        "Emotional reaction close-ups of women touching their faces, looking in mirrors — warm but slightly desaturated tones to show dissatisfaction. Slow, intimate camera movements. Builds personal connection by making the viewer SEE the pain on real faces.",
        "Clinical detail shots of dark spots, skin textures, dermatologist tools — cool whites and clinical blues under harsh fluorescent lighting. Static or slow zoom. Creates medical urgency and proves the problem is real, not cosmetic vanity.",
        "Lifestyle scenario shots of women avoiding social situations, canceling plans — muted earth tones, natural but dim lighting. Handheld feel. Shows the REAL COST of the problem beyond appearance — isolation and lost confidence."
      ]
    },
    {
      "beat_name": "The Scale Reveal",
      "beat_emotion": "Shock at how widespread this is",
      "matched_reference_beat": "The Scientific Proof",
      "matched_from_chapter": "The Scientific Breakthrough",
      "matched_from_chapter_number": 3,
      "match_reason": "This beat from Chapter 3 has a stronger proof-and-scale emotion than the Chapter 1 equivalent",
      "strategy_points": [
        "Statistical and document proof shots — charts, survey results, news headlines — clean whites and neutral backgrounds. Static. Sharp contrast from the emotional previous beat — shifts from 'one woman's story' to 'this affects everyone'. The white/neutral palette signals objectivity and data.",
        "Rapid montage of diverse women's faces showing concern — warm skin tones but cool background lighting. Quick cuts (2-3 seconds). Proves scale through volume — many faces = widespread problem."
      ]
    }
  ]`

// ── Update create_strategy (id=8) ──
const strategy8 = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1").get()
if (!strategy8) { console.error('No create_strategy found'); process.exit(1) }

const ver8 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy8.id)
const stages8 = JSON.parse(ver8.stages_json)
const stageIdx8 = stages8.findIndex(s => s.per_chapter)

if (stageIdx8 !== -1) {
  let prompt = stages8[stageIdx8].prompt

  // Replace Step 5 instructions
  const step5Old = `## Step 5: Build per-beat strategies (CRITICAL)

This is the most important part. For each beat in THIS chapter:

1. Use the best-matching reference beat you found in Step 3 — it can be from ANY reference chapter
2. ADAPT that beat's strategy_points to fit THIS beat's content. Each strategy point must include:
   - WHAT to show and WHY (the editorial job)
   - COLORS and WHY those colors (what emotion they create)
   - STYLE/MOTION and WHY
   - How the style SHIFTS from the previous beat and what that shift accomplishes emotionally
3. If NO reference beat matches well, create strategy points from scratch using the chapter-level patterns
4. Typically 1-4 strategy points per beat — group by visual purpose, not individual clips

The beat strategies define the EMOTIONAL ARC of visual storytelling through the chapter. Each beat should feel intentionally different from the last when the emotion changes.`

  const step5New = `## Step 5: Build per-beat strategies (CRITICAL)

This is the most important part.

${beatStrategyInstructions}

If NO reference beat matches well, create strategy points from scratch using the chapter-level patterns.

The beat strategies define the EMOTIONAL ARC of visual storytelling through the chapter. Each beat should feel intentionally different from the last when the emotion changes.`

  prompt = prompt.replace(step5Old, step5New)

  // Replace the JSON example's beat_strategies section
  const oldExamples = `"beat_strategies": [
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
      "match_reason": "This beat from Chapter 3 has a stronger proof-and-scale emotion than the Chapter 1 equivalent",
      "strategy_points": [
        "Rapid montage of diverse faces showing concern — warm skin tones, cool backgrounds, quick 2-3 second cuts. Volume of faces = scale of problem.",
        "Document and chart proof shots — clean whites, neutral backgrounds. Static. Color shift from warm faces to cool data signals 'here are the facts'."
      ]
    }
  ]`

  const newExamples = `"beat_strategies": ${beatStrategyExamples}`

  prompt = prompt.replace(oldExamples, newExamples)

  stages8[stageIdx8].prompt = prompt
  await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages8), ver8.id)
  console.log(`Updated create_strategy (id=${strategy8.id}): Step 5 now uses flowing paragraph style`)
} else {
  console.error('No per_chapter stage found in create_strategy')
}

// ── Update create_combined_strategy (id=10) ──
const strategy10 = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1").get()
if (!strategy10) { console.error('No create_combined_strategy found'); process.exit(1) }

const ver10 = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy10.id)
const stages10 = JSON.parse(ver10.stages_json)

// Stage 2 is "Create combined B-Roll strategy" — the one with per-beat instructions
const stageIdx10 = stages10.findIndex(s => s.name?.includes('combined') || s.name?.includes('Create combined'))
if (stageIdx10 !== -1) {
  let prompt = stages10[stageIdx10].prompt

  // Replace Step 3 instructions
  const step3Old = `### Step 3: Build per-beat strategies (CRITICAL)
For each beat, ADAPT the selected reference beat's strategy_points to fit YOUR beat's specific content:
- Keep the visual approach and emotional intent from the reference
- Change the specific descriptions to match YOUR beat's transcript content
- Ensure style TRANSITIONS between beats feel cohesive even though they come from different references
- If two adjacent beats come from very different reference styles, explain how to bridge them`

  const step3New = `### Step 3: Build per-beat strategies (CRITICAL)
${beatStrategyInstructions}

Additionally, since beats may come from different references:
- Ensure style TRANSITIONS between beats feel cohesive even though they come from different references
- If two adjacent beats come from very different reference styles, weave the transition into the strategy point descriptions`

  prompt = prompt.replace(step3Old, step3New)

  // Replace the JSON example's beat_strategies
  const oldCombinedExamples = `"beat_strategies": [
    {
      "beat_name": "The Opening Hook",
      "beat_emotion": "Shock and urgency",
      "selected_from": "Crunchy Brain Syndrome / The Amazing Memory Man",
      "strategy_points": [
        "Adapted strategy point 1 — specific to THIS beat's content...",
        "Adapted strategy point 2..."
      ]
    }
  ]`

  const newCombinedExamples = `"beat_strategies": [
    {
      "beat_name": "The Opening Hook",
      "beat_emotion": "Shock and urgency",
      "selected_from": "Crunchy Brain Syndrome / The Amazing Memory Man",
      "strategy_points": [
        "Emotional reaction close-ups of people freezing mid-task, staring at screens — warm but slightly desaturated tones to show cognitive overload. Slow, intimate camera movements. Builds personal connection by making the viewer SEE the struggle on real faces.",
        "Clinical detail shots of brain scans, neurological diagrams — cool whites and clinical blues under harsh lighting. Static or slow zoom. Sharp shift from the emotional previous shots — moves from 'you feel this' to 'here is the science'. The white/neutral palette signals authority."
      ]
    }
  ]`

  prompt = prompt.replace(oldCombinedExamples, newCombinedExamples)

  stages10[stageIdx10].prompt = prompt
  await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages10), ver10.id)
  console.log(`Updated create_combined_strategy (id=${strategy10.id}): Step 3 now uses flowing paragraph style`)
} else {
  console.error('No combined strategy stage found')
}

process.exit(0)
