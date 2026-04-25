import db from '../db.js'

const strat = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1").get()
if (!strat) { console.error('No create_strategy found'); process.exit(1) }

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strat.id)
const stages = JSON.parse(ver.stages_json)

const stage0 = stages[0]

// === Fix System Instruction ===

// Replace the Process section and HARD RULES
let sys = stage0.system_instruction

// Replace Process section
sys = sys.replace(
  /## Process:[\s\S]*?(?=## HARD RULES:)/,
  `## Process:
1. You receive ONE reference video's beat strategies (from its analysis)
2. You receive ONE chapter from the new video (its purpose, beats, transcript)
3. For each of your beats, match it to the best reference beat by purpose and emotion
4. Adapt the matched reference beat's strategy_points to fit your video's content

`)

// Replace HARD RULES
sys = sys.replace(
  /## HARD RULES:[\s\S]*?(?=Output ONLY valid JSON)/,
  `## HARD RULES:
- NO TEXT OVERLAYS: Do NOT suggest text overlays, text highlights, callout text, or any on-screen text elements. Only suggest B-Roll footage, Graphic Packages, and Overlay Images (non-text visual elements like icons, logos, product images).
- USE REFERENCE FREQUENCY: Each matched beat has a reference_frequency (broll_per_minute, avg_duration). Use these as your frequency targets per beat.
- ADAPT, DON'T COPY: The reference strategy_points are your visual blueprint. Keep the same color logic, motion approach, and editorial functions — but rewrite them entirely for THIS beat's specific content and script.

`)

stage0.system_instruction = sys

// === Fix Prompt ===

stage0.prompt = `You are creating a B-Roll strategy for ONE chapter of a new video based on a reference video's beat strategies.

## REFERENCE VIDEO BEAT STRATEGIES
Each reference chapter contains beats with strategy_points (visual approaches) and reference_frequency (b-rolls per minute, avg duration).

{{reference_analysis_slim}}

## THIS CHAPTER
Chapter {{chapter_number}}: "{{chapter_name}}"
Time: {{chapter_start_tc}} - {{chapter_end_tc}} ({{chapter_duration_seconds}} seconds)
Purpose: {{chapter_purpose}}

A-Roll appearance (your B-Roll style must complement this):
{{llm_answer_1}}

Beats:
{{chapter_beats}}

Transcript:
{{chapter_transcript}}

## INSTRUCTIONS

### Step 1: Match beats

For each beat in THIS chapter, scan ALL reference chapters' beat_strategies. Find the reference beat whose editorial approach best fits.

Match by:
1. **Beat PURPOSE and EMOTION first** — a "hook with shock" beat matches another "hook with urgency" beat, regardless of which reference chapter it's in
2. **Strategy_points quality** — which reference beat's strategy_points would best serve your beat's content?
3. A beat from a different reference chapter can be the best match — match at beat level, not chapter level

### Step 2: Build per-beat strategies (CRITICAL)

For each beat, ADAPT the matched reference beat's strategy_points to fit THIS beat's content.

A strategy point answers: "What visual approach is used, what does it look like, and WHY does it look that way?"

#### How to write strategy points:
1. Take the matched reference beat's strategy_points as your starting template
2. ADAPT them to fit THIS beat's transcript content — change the specific subjects and scenarios but keep the visual approach
3. For each group, describe the visual approach as ONE strategy point

#### Each strategy point MUST include:
- WHAT is shown and WHY (the editorial job this group of b-rolls does)
- COLORS used and WHY those colors (what feeling do they create)
- STYLE/MOTION and WHY (slow = authority, fast = urgency, handheld = authenticity, etc.)
- If the colors or style SHIFT from the previous strategy point or beat, explain the shift and what it accomplishes emotionally

Write each strategy point as a single flowing paragraph that weaves all of the above together naturally — not as separate sub-items.

#### What NOT to do:
- Do NOT list individual elements — find what's COMMON across them
- Do NOT describe more than 5 strategy points per beat — merge similar approaches
- Do NOT use generic descriptions — anchor to THIS beat's specific content
- If a beat only has one visual approach, that's fine — one strategy point

#### How many strategy points?
Count how many DISTINCT visual purposes the b-rolls serve in this beat. Each distinct purpose = one strategy point. Typically 1-4 per beat.

### Step 3: Match A-Roll style
All B-Roll style notes must complement the A-Roll appearance — similar color temperature, compatible tones, coherent visual feel.

Return JSON:
\`\`\`json
{
  "chapter_name": "{{chapter_name}}",
  "beat_strategies": [
    {
      "beat_name": "The Opening Hook",
      "beat_emotion": "Anxiety and personal threat",
      "matched_reference_beat": "Margaret's Devastating Discovery",
      "match_reason": "Both beats establish personal emotional pain to hook the viewer",
      "strategy_points": [
        "Emotional reaction close-ups of women touching their faces, looking in mirrors — warm but slightly desaturated tones to show dissatisfaction. Slow, intimate camera movements. Builds personal connection by making the viewer SEE the pain on real faces.",
        "Clinical detail shots of dark spots, skin textures, dermatologist tools — cool whites and clinical blues under harsh fluorescent lighting. Static or slow zoom. Creates medical urgency and proves the problem is real, not cosmetic vanity."
      ]
    }
  ]
}
\`\`\`

Rules:
- One entry per beat — every beat in your chapter must appear
- \`beat_emotion\` — create an emotion for this beat based on your video's content
- \`strategy_points\` — adapted to your script, using the reference as a blueprint
- \`matched_reference_beat\` — exact beat name from the reference analysis
- Keep \`match_reason\` concise — one sentence`

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)

console.log(`Single strategy (id=${strat.id}) updated:`)
console.log('  - Fixed: Process section aligned with Prompt steps')
console.log('  - Fixed: HARD RULES — removed chapter-level frequency/usage/style, added per-beat frequency rule')
console.log('  - Removed: matched_from_chapter, matched_from_chapter_number from output')
console.log('  - Removed: {{chapter_emotion}} (not available from prep)')
console.log('  - Added: chapter_name to output')
console.log('  - Kept: one LLM call + enrich_beat_frequency programmatic stage')
process.exit(0)
