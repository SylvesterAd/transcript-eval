import db from '../db.js'

const strat = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_plan' ORDER BY id LIMIT 1").get()
if (!strat) { console.error('No create_plan strategy found'); process.exit(1) }

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strat.id)
const stages = JSON.parse(ver.stages_json)

const planStage = stages.find(s => s.per_chapter)
if (!planStage) { console.error('No per_chapter stage found'); process.exit(1) }

planStage.prompt = `Create exact B-Roll / Graphic Package / Overlay placements for this chapter.

## ── THIS CHAPTER ──
"{{chapter_name}}" ({{chapter_start_tc}} - {{chapter_end_tc}}, {{chapter_duration_seconds}}s)
Purpose: {{chapter_purpose}}
Emotion: {{chapter_emotion}}

Beats:
{{chapter_beats}}

## ── CHAPTER TRANSCRIPT (use these timecodes for your placements) ──
{{chapter_transcript}}

## ── BEAT STRATEGIES (you MUST follow these) ──
{{prev_chapter_output}}

## ── FULL VIDEO CONTEXT (all chapters for continuity) ──
{{all_chapters}}

## ── INSTRUCTIONS ──

The beat_strategies above contain per-beat guidance:
- **beat_name** and **beat_emotion**: what this beat is about
- **strategy_points**: flowing descriptions of what B-Roll to show, colors, style, motion — follow these closely
- **reference_frequency** (if available): the reference video's broll_per_minute and broll_avg_duration_seconds for this beat

Your job: create SPECIFIC placements that execute each beat's strategy.

### FREQUENCY (per beat):
For each beat, calculate placements using its reference_frequency:
- placements needed = broll_per_minute × (beat_duration_seconds / 60)
- avg clip length = broll_avg_duration_seconds (typically 2-5 seconds)
- If reference_frequency is not available, use a default of ~8-12 b-rolls per minute with ~3s average duration
- Distribute placements evenly across the beat's transcript timecodes

### PLACEMENT RULES:
- Every placement MUST have start/end timecodes from the transcript — real timestamps, not made up
- Every placement MUST have an audio_anchor — the exact phrase being spoken at that moment
- Each description must be SPECIFIC to the content being discussed — never generic
- Follow the strategy_points' visual approach: colors, style, motion, emotional purpose
- ONE B-Roll = ONE scene. Do NOT put transitions or multiple actions inside a single B-Roll description. A single B-Roll should describe one continuous visual moment.

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
      "beat": "The Opening Hook",
      "category": "broll",
      "audio_anchor": "stopped me cold",
      "function": "Proof - Validate claim",
      "trigger": "When she mentions reading something shocking",
      "type_group": "Document / Media proof",
      "source_feel": "Stock footage & cinematic",
      "description": "Close-up of a newspaper featuring the headline with yellow-highlighted text for emphasis",
      "style": {
        "colors": "black, white, yellow highlight",
        "temperature": "cool",
        "motion": "slow pan"
      }
    },
    {
      "start": "[00:00:17]",
      "end": "[00:00:22]",
      "beat": "The Scale Reveal",
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
      "beat": "The Opening Hook",
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

// Also remove "Text highlight" from the system instruction Type Group
let sys = planStage.system_instruction
sys = sys.replace(/Text highlight \([^)]*\)\n/g, '')

// Add no-text-overlay rule if not already present
if (!sys.includes('NO TEXT OVERLAYS')) {
  sys = sys.replace(
    '# Your Role:',
    `## HARD RULES:
- NO TEXT OVERLAYS: Do NOT suggest text overlays, text highlights, callout text, or any on-screen text elements. Only suggest B-Roll footage, Graphic Packages, and Overlay Images (non-text visual elements like icons, logos, product images).

# Your Role:`
  )
}

// Update role description
sys = sys.replace(
  `# Your Role:
You are a senior video editor creating exact B-Roll placements for ONE chapter. You have:
1. Reference video patterns (what worked before)
2. The B-Roll strategy (target frequencies, rules)
3. The chapter's transcript with exact timecodes`,
  `# Your Role:
You are a senior video editor creating exact B-Roll placements for ONE chapter. You have:
1. Per-beat strategies with visual approach, colors, style (from reference analysis)
2. Per-beat frequency targets (b-rolls per minute, avg duration)
3. The chapter's transcript with exact timecodes`
)

planStage.system_instruction = sys

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)

console.log(`Plan strategy (id=${strat.id}) updated:`)
console.log('  - Prompt: now uses beat-level frequency from reference_frequency')
console.log('  - Removed: chapter-level frequency_targets, strategy.broll/gp/overlay references')
console.log('  - Added: per-beat placement calculation from reference_frequency')
console.log('  - Added: "beat" field in placement JSON output')
console.log('  - Added: NO TEXT OVERLAYS rule')
console.log('  - Removed: Text highlight from Type Group')
process.exit(0)
