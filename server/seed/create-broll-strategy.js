import db from '../db.js'

const strat = await db.prepare(`
  INSERT INTO broll_strategies (name, description, strategy_kind, analysis_model, analysis_system_prompt, plan_model, plan_system_prompt)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`).run(
  'Main Video B-Roll Analysis',
  'Analyzes the main video (transcript + visuals) to identify B-Roll placement opportunities',
  'main_analysis',
  'gemini-3-flash-preview', '', 'gpt-5.4', ''
)
const stratId = strat.lastInsertRowid
console.log('Strategy created:', stratId)

const stages = [
  {
    name: 'Identify Structure',
    type: 'transcript_question',
    target: 'main_video',
    model: 'gemini-3-flash-preview',
    system_instruction: `You are a video content structure analyst. Analyze the transcript and identify the complete structure of this video.

Output ONLY valid JSON.`,
    prompt: `Analyze this transcript and identify:
1. All chapters/sections with start and end timecodes
2. Key beats within each chapter (moments where something changes)
3. The type of content in each section (talking head, demo, story, explanation, etc.)

Return JSON:
\`\`\`json
{
  "chapters": [
    {
      "timecode_start": "[HH:MM:SS]",
      "timecode_end": "[HH:MM:SS]",
      "name": "Chapter name",
      "content_type": "talking_head|demo|story|explanation|interview|montage",
      "description": "What this section covers",
      "beats": [
        { "timecode": "[HH:MM:SS]", "description": "What happens", "emotion": "informative|exciting|tense|humorous|reflective" }
      ]
    }
  ]
}
\`\`\`

{{transcript}}`,
    params: { temperature: 0.2, thinking_level: 'MEDIUM' },
  },
  {
    name: 'Visual Analysis',
    type: 'video_llm',
    target: 'main_video',
    model: 'gemini-3-flash-preview',
    system_instruction: `You are an expert video editor analyzing footage for B-Roll opportunities. Watch the video carefully and describe what you see.

Focus on:
- What is visually on screen at each moment (talking head, screen recording, whiteboard, product, etc.)
- Camera angles and framing changes
- Moments where the visual is static/boring (just talking head) — these are B-Roll opportunities
- Moments where the speaker references something that could be shown visually
- Natural transition points between topics

Output ONLY valid JSON.`,
    prompt: `Watch this video and create a detailed visual timeline.

Here is the content structure from transcript analysis for context:
{{llm_answer_1}}

For every 15-30 second segment, describe:
- What is visually on screen
- Whether it is engaging or static (talking head = static)
- Any visual references the speaker makes (e.g. "look at this", "imagine", "for example")

Return JSON:
\`\`\`json
{
  "visual_segments": [
    {
      "start_seconds": 0,
      "end_seconds": 30,
      "visual_description": "Speaker talking to camera, medium shot",
      "is_static": true,
      "speaker_references": ["mentions their product dashboard"],
      "broll_opportunity": true,
      "suggested_broll": "Screen recording of the product dashboard"
    }
  ]
}
\`\`\``,
    params: { temperature: 0.2, thinking_level: 'LOW' },
  },
  {
    name: 'B-Roll Plan',
    type: 'transcript_question',
    target: 'text_only',
    model: 'gemini-3.1-pro-preview',
    system_instruction: `You are a senior video editor creating a B-Roll placement plan. You have:
1. The video's content structure (chapters and beats)
2. A visual analysis of what is on screen throughout the video

Your job is to create a specific, actionable B-Roll plan with exact timestamps and descriptions of what B-Roll to use.

Rules:
- B-Roll should enhance understanding, not distract
- Do not cover important on-camera moments (demonstrations, emotional reactions)
- Prioritize covering static talking-head sections where the speaker describes something visual
- Each B-Roll clip should be 3-8 seconds long
- Include a mix of types: stock footage, screen recordings, graphics, text overlays, PIP
- Consider pacing — do not put B-Roll everywhere, let some talking head moments breathe

Output ONLY valid JSON.`,
    prompt: `Create a B-Roll placement plan for this video.

## Content Structure (from transcript analysis):
{{llm_answer_1}}

## Visual Analysis (from watching the video):
{{stage_2_output}}

Generate a complete B-Roll plan. For each placement:
- Exact start/end timestamps
- Type of B-Roll (stock_footage, screen_recording, graphic, text_overlay, pip, photo)
- Search keywords for finding the right stock footage
- Priority (high/medium/low) — high = really needs B-Roll here, low = nice to have

Return JSON:
\`\`\`json
{
  "total_broll_clips": 15,
  "total_broll_duration_seconds": 120,
  "placements": [
    {
      "start_seconds": 12,
      "end_seconds": 18,
      "chapter": "Introduction",
      "type": "stock_footage",
      "description": "Aerial shot of busy city street",
      "search_keywords": ["aerial city", "busy street", "urban crowd"],
      "reason": "Speaker talks about urban growth while static on camera",
      "priority": "high"
    }
  ]
}
\`\`\``,
    params: { temperature: 0.3, thinking_level: 'HIGH' },
  }
]

const ver = await db.prepare(`
  INSERT INTO broll_strategy_versions (strategy_id, name, notes, stages_json)
  VALUES ($1, $2, $3, $4)
`).run(stratId, 'Version 1', 'Transcript structure + video visual analysis + B-Roll plan', JSON.stringify(stages))

console.log('Version created:', ver.lastInsertRowid)
console.log('Done — 3 stages: Identify Structure -> Visual Analysis -> B-Roll Plan')
process.exit(0)
