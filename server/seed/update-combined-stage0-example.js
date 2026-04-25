import db from '../db.js'

const strat = await db.prepare("SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1").get()
if (!strat) { console.error('No create_combined_strategy found'); process.exit(1) }

const ver = await db.prepare('SELECT id, stages_json FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strat.id)
const stages = JSON.parse(ver.stages_json)

const stage0 = stages[0]

// Replace the JSON example + rules section
stage0.prompt = stage0.prompt.replace(
  /Return JSON:[\s\S]*$/,
  `Return JSON:
\`\`\`json
{
  "chapter_name": "{{chapter_name}}",
  "beat_matches": [
    {
      "new_video_beat": "The Opening Hook",
      "new_video_beat_emotion": "Shock and urgency",
      "matched_reference": "Crunchy Brain Syndrome",
      "matched_reference_chapter": "The Mystery of Mark",
      "matched_reference_beat": "The Amazing Memory Man",
      "match_reason": "Both beats hook through extraordinary personal stories that sound too good to be true"
    },
    {
      "new_video_beat": "The Scale Reveal",
      "new_video_beat_emotion": "Growing alarm",
      "matched_reference": "Dark Spot Solution",
      "matched_reference_chapter": "The Hidden Epidemic",
      "matched_reference_beat": "The Staggering Numbers",
      "match_reason": "Both beats use statistical proof to escalate from personal story to widespread problem"
    }
  ]
}
\`\`\`

Rules:
- One match per beat — every beat in your chapter must have exactly one match
- \\\`matched_reference\\\` must be the reference video name (from the header), not an ID
- \\\`matched_reference_chapter\\\` and \\\`matched_reference_beat\\\` must be exact names from the reference analysis
- \\\`new_video_beat_emotion\\\` — invent this based on what's happening in the transcript at this beat
- Keep \\\`match_reason\\\` concise — one sentence
- Beats CAN match to different references — pick the best match regardless of which reference it comes from`
)

await db.prepare('UPDATE broll_strategy_versions SET stages_json = ? WHERE id = ?').run(JSON.stringify(stages), ver.id)
console.log('Stage 0 JSON example updated: now shows 2 beats matching 2 different references')
process.exit(0)
